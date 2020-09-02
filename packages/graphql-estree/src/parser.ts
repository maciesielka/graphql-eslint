import {
  Lexer,
  DirectiveLocation,
  TokenKind,
  Source,
  syntaxError,
  TokenKindEnum,
  GraphQLError,
  Token,
  ParseOptions,
  Kind,
  Location as GraphQLLocation,
} from "graphql";
import { GraphQLESTree } from "@graphql-eslint/types";
import { isPunctuatorTokenKind } from "graphql/language/lexer";
import { BaseNode, Comment } from "estree";

/**
 * Given a GraphQL source, parses it into a Document.
 * Throws GraphQLError if a syntax error is encountered.
 */
export function parse(
  source: string | Source,
  options?: ParseOptions
): GraphQLESTree.DocumentNode {
  const parser = new ESTreeParser(source, options);
  return parser.parseDocument();
}

/**
 * Given a string containing a GraphQL value (ex. `[42]`), parse the AST for
 * that value.
 * Throws GraphQLError if a syntax error is encountered.
 *
 * This is useful within tools that operate upon GraphQL Values directly and
 * in isolation of complete GraphQL documents.
 *
 * Consider providing the results to the utility function: valueFromAST().
 */
export function parseValue(
  source: string | Source,
  options?: ParseOptions
): GraphQLESTree.ValueNode {
  const parser = new ESTreeParser(source, options);
  parser.expectToken(TokenKind.SOF);
  const value = parser.parseValueLiteral(false);
  parser.expectToken(TokenKind.EOF);
  return value;
}

/**
 * Given a string containing a GraphQL Type (ex. `[Int!]`), parse the AST for
 * that type.
 * Throws GraphQLError if a syntax error is encountered.
 *
 * This is useful within tools that operate upon GraphQL Types directly and
 * in isolation of complete GraphQL documents.
 *
 * Consider providing the results to the utility function: typeFromAST().
 */
export function parseType(
  source: string | Source,
  options?: ParseOptions
): GraphQLESTree.TypeNode {
  const parser = new ESTreeParser(source, options);
  parser.expectToken(TokenKind.SOF);
  const type = parser.parseTypeReference();
  parser.expectToken(TokenKind.EOF);
  return type;
}

/**
 * This class is exported only to assist people in implementing their own parsers
 * without duplicating too much code and should be used only as last resort for cases
 * such as experimental syntax or if certain features could not be contributed upstream.
 *
 * It is still part of the internal API and is versioned, so any changes to it are never
 * considered breaking changes. If you still need to support multiple versions of the
 * library, please use the `versionInfo` variable for version detection.
 *
 * @internal
 */
export class ESTreeParser {
  _options?: ParseOptions;
  _lexer: Lexer;

  constructor(source: string | Source, options?: ParseOptions) {
    const sourceObj = typeof source === "string" ? new Source(source) : source;
    this._lexer = new Lexer(sourceObj);
    this._options = options;
  }

  /**
   * Converts a name lex token into a name parse node.
   */
  parseName(): GraphQLESTree.NameNode {
    const token = this.expectToken(TokenKind.NAME);
    return {
      type: Kind.NAME,
      value: (token.value as any) as string,
      ...this.loc(token),
    };
  }

  // Implements the parsing rules in the Document section.

  /**
   * Document : Definition+
   */
  parseDocument(): GraphQLESTree.DocumentNode {
    const start = this._lexer.token;

    return {
      type: Kind.DOCUMENT,
      source: this._lexer.source.body,
      definitions: this.many(
        TokenKind.SOF,
        this.parseDefinition,
        TokenKind.EOF
      ),
      ...this.loc(start),
    };
  }

  /**
   * Definition :
   *   - ExecutableDefinition
   *   - TypeSystemDefinition
   *   - TypeSystemExtension
   *
   * ExecutableDefinition :
   *   - OperationDefinition
   *   - FragmentDefinition
   */
  parseDefinition(): GraphQLESTree.DefinitionNode {
    if (this.peek(TokenKind.NAME)) {
      switch (this._lexer.token.value) {
        case "query":
        case "mutation":
        case "subscription":
          return this.parseOperationDefinition();
        case "fragment":
          return this.parseFragmentDefinition();
        case "schema":
        case "scalar":
        case "type":
        case "interface":
        case "union":
        case "enum":
        case "input":
        case "directive":
          return this.parseTypeSystemDefinition();
        case "extend":
          return this.parseTypeSystemExtension();
      }
    } else if (this.peek(TokenKind.BRACE_L)) {
      return this.parseOperationDefinition();
    } else if (this.peekDescription()) {
      return this.parseTypeSystemDefinition();
    }

    throw this.unexpected();
  }

  // Implements the parsing rules in the Operations section.

  /**
   * OperationDefinition :
   *  - SelectionSet
   *  - OperationType Name? VariableDefinitions? Directives? SelectionSet
   */
  parseOperationDefinition(): GraphQLESTree.OperationDefinitionNode {
    const start = this._lexer.token;
    if (this.peek(TokenKind.BRACE_L)) {
      return {
        type: Kind.OPERATION_DEFINITION,
        operation: "query",
        name: undefined,
        variableDefinitions: [],
        directives: [],
        selectionSet: this.parseSelectionSet(),
        ...this.loc(start),
      };
    }
    const operation = this.parseOperationType();
    let name;
    if (this.peek(TokenKind.NAME)) {
      name = this.parseName();
    }
    return {
      type: Kind.OPERATION_DEFINITION,
      operation,
      name,
      variableDefinitions: this.parseVariableDefinitions(),
      directives: this.parseDirectives(false),
      selectionSet: this.parseSelectionSet(),
      ...this.loc(start),
    };
  }

  /**
   * OperationType : one of query mutation subscription
   */
  parseOperationType(): GraphQLESTree.OperationTypeNode {
    const operationToken = this.expectToken(TokenKind.NAME);
    switch (operationToken.value) {
      case "query":
        return "query";
      case "mutation":
        return "mutation";
      case "subscription":
        return "subscription";
    }

    throw this.unexpected(operationToken);
  }

  /**
   * VariableDefinitions : ( VariableDefinition+ )
   */
  parseVariableDefinitions(): Array<GraphQLESTree.VariableDefinitionNode> {
    return this.optionalMany(
      TokenKind.PAREN_L,
      this.parseVariableDefinition,
      TokenKind.PAREN_R
    );
  }

  /**
   * VariableDefinition : Variable : Type DefaultValue? Directives[Const]?
   */
  parseVariableDefinition(): GraphQLESTree.VariableDefinitionNode {
    const start = this._lexer.token;
    return {
      type: Kind.VARIABLE_DEFINITION,
      variable: this.parseVariable(),
      ofType: (this.expectToken(TokenKind.COLON), this.parseTypeReference()),
      defaultValue: this.expectOptionalToken(TokenKind.EQUALS)
        ? this.parseValueLiteral(true)
        : undefined,
      directives: this.parseDirectives(true),
      ...this.loc(start),
    };
  }

  /**
   * Variable : $ Name
   */
  parseVariable(): GraphQLESTree.VariableNode {
    const start = this._lexer.token;
    this.expectToken(TokenKind.DOLLAR);
    return {
      type: Kind.VARIABLE,
      name: this.parseName(),
      ...this.loc(start),
    };
  }

  /**
   * SelectionSet : { Selection+ }
   */
  parseSelectionSet(): GraphQLESTree.SelectionSetNode {
    const start = this._lexer.token;
    return {
      type: Kind.SELECTION_SET,
      selections: this.many(
        TokenKind.BRACE_L,
        this.parseSelection,
        TokenKind.BRACE_R
      ),
      ...this.loc(start),
    };
  }

  /**
   * Selection :
   *   - Field
   *   - FragmentSpread
   *   - InlineFragment
   */
  parseSelection(): GraphQLESTree.SelectionNode {
    return this.peek(TokenKind.SPREAD)
      ? this.parseFragment()
      : this.parseField();
  }

  /**
   * Field : Alias? Name Arguments? Directives? SelectionSet?
   *
   * Alias : Name :
   */
  parseField(): GraphQLESTree.FieldNode {
    const start = this._lexer.token;

    const nameOrAlias = this.parseName();
    let alias;
    let name;
    if (this.expectOptionalToken(TokenKind.COLON)) {
      alias = nameOrAlias;
      name = this.parseName();
    } else {
      name = nameOrAlias;
    }

    return {
      type: Kind.FIELD,
      alias,
      name,
      arguments: this.parseArguments(false),
      directives: this.parseDirectives(false),
      selectionSet: this.peek(TokenKind.BRACE_L)
        ? this.parseSelectionSet()
        : undefined,
      ...this.loc(start),
    };
  }

  /**
   * Arguments[Const] : ( Argument[?Const]+ )
   */
  parseArguments(isConst: boolean): Array<GraphQLESTree.ArgumentNode> {
    const item = isConst ? this.parseConstArgument : this.parseArgument;
    return this.optionalMany(TokenKind.PAREN_L, item, TokenKind.PAREN_R);
  }

  /**
   * Argument[Const] : Name : Value[?Const]
   */
  parseArgument(): GraphQLESTree.ArgumentNode {
    const start = this._lexer.token;
    const name = this.parseName();

    this.expectToken(TokenKind.COLON);
    return {
      type: Kind.ARGUMENT,
      name,
      value: this.parseValueLiteral(false),
      ...this.loc(start),
    };
  }

  parseConstArgument(): GraphQLESTree.ArgumentNode {
    const start = this._lexer.token;
    return {
      type: Kind.ARGUMENT,
      name: this.parseName(),
      value: (this.expectToken(TokenKind.COLON), this.parseValueLiteral(true)),
      ...this.loc(start),
    };
  }

  // Implements the parsing rules in the Fragments section.

  /**
   * Corresponds to both FragmentSpread and InlineFragment in the spec.
   *
   * FragmentSpread : ... FragmentName Directives?
   *
   * InlineFragment : ... TypeCondition? Directives? SelectionSet
   */
  parseFragment():
    | GraphQLESTree.FragmentSpreadNode
    | GraphQLESTree.InlineFragmentNode {
    const start = this._lexer.token;
    this.expectToken(TokenKind.SPREAD);

    const hasTypeCondition = this.expectOptionalKeyword("on");
    if (!hasTypeCondition && this.peek(TokenKind.NAME)) {
      return {
        type: Kind.FRAGMENT_SPREAD,
        name: this.parseFragmentName(),
        directives: this.parseDirectives(false),
        ...this.loc(start),
      };
    }
    return {
      type: Kind.INLINE_FRAGMENT,
      typeCondition: hasTypeCondition ? this.parseNamedType() : undefined,
      directives: this.parseDirectives(false),
      selectionSet: this.parseSelectionSet(),
      ...this.loc(start),
    };
  }

  /**
   * FragmentDefinition :
   *   - fragment FragmentName on TypeCondition Directives? SelectionSet
   *
   * TypeCondition : NamedType
   */
  parseFragmentDefinition(): GraphQLESTree.FragmentDefinitionNode {
    const start = this._lexer.token;
    this.expectKeyword("fragment");
    // Experimental support for defining variables within fragments changes
    // the grammar of FragmentDefinition:
    //   - fragment FragmentName VariableDefinitions? on TypeCondition Directives? SelectionSet
    if (this._options?.experimentalFragmentVariables === true) {
      return {
        type: Kind.FRAGMENT_DEFINITION,
        name: this.parseFragmentName(),
        variableDefinitions: this.parseVariableDefinitions(),
        typeCondition: (this.expectKeyword("on"), this.parseNamedType()),
        directives: this.parseDirectives(false),
        selectionSet: this.parseSelectionSet(),
        ...this.loc(start),
      };
    }
    return {
      type: Kind.FRAGMENT_DEFINITION,
      name: this.parseFragmentName(),
      typeCondition: (this.expectKeyword("on"), this.parseNamedType()),
      directives: this.parseDirectives(false),
      selectionSet: this.parseSelectionSet(),
      ...this.loc(start),
    };
  }

  /**
   * FragmentName : Name but not `on`
   */
  parseFragmentName(): GraphQLESTree.NameNode {
    if (this._lexer.token.value === "on") {
      throw this.unexpected();
    }
    return this.parseName();
  }

  // Implements the parsing rules in the Values section.

  /**
   * Value[Const] :
   *   - [~Const] Variable
   *   - IntValue
   *   - FloatValue
   *   - StringValue
   *   - BooleanValue
   *   - NullValue
   *   - EnumValue
   *   - ListValue[?Const]
   *   - ObjectValue[?Const]
   *
   * BooleanValue : one of `true` `false`
   *
   * NullValue : `null`
   *
   * EnumValue : Name but not `true`, `false` or `null`
   */
  parseValueLiteral(isConst: boolean): GraphQLESTree.ValueNode {
    const token = this._lexer.token;
    switch (token.kind) {
      case TokenKind.BRACKET_L:
        return this.parseList(isConst);
      case TokenKind.BRACE_L:
        return this.parseObject(isConst);
      case TokenKind.INT:
        this._lexer.advance();
        return {
          type: Kind.INT,
          value: (token.value as any) as string,
          ...this.loc(token),
        };
      case TokenKind.FLOAT:
        this._lexer.advance();
        return {
          type: Kind.FLOAT,
          value: (token.value as any) as string,
          ...this.loc(token),
        };
      case TokenKind.STRING:
      case TokenKind.BLOCK_STRING:
        return this.parseStringLiteral();
      case TokenKind.NAME:
        this._lexer.advance();
        switch (token.value) {
          case "true":
            return { type: Kind.BOOLEAN, value: true, ...this.loc(token) };
          case "false":
            return { type: Kind.BOOLEAN, value: false, ...this.loc(token) };
          case "null":
            return { type: Kind.NULL, ...this.loc(token) };
          default:
            return {
              type: Kind.ENUM,
              value: (token.value as any) as string,
              ...this.loc(token),
            };
        }
      case TokenKind.DOLLAR:
        if (!isConst) {
          return this.parseVariable();
        }
        break;
    }
    throw this.unexpected();
  }

  parseStringLiteral(): GraphQLESTree.StringValueNode {
    const token = this._lexer.token;
    this._lexer.advance();
    return {
      type: Kind.STRING,
      value: (token.value as any) as string,
      block: token.kind === TokenKind.BLOCK_STRING,
      ...this.loc(token),
    };
  }

  /**
   * ListValue[Const] :
   *   - [ ]
   *   - [ Value[?Const]+ ]
   */
  parseList(isConst: boolean): GraphQLESTree.ListValueNode {
    const start = this._lexer.token;
    const item = () => this.parseValueLiteral(isConst);
    return {
      type: Kind.LIST,
      values: this.any(TokenKind.BRACKET_L, item, TokenKind.BRACKET_R),
      ...this.loc(start),
    };
  }

  /**
   * ObjectValue[Const] :
   *   - { }
   *   - { ObjectField[?Const]+ }
   */
  parseObject(isConst: boolean): GraphQLESTree.ObjectValueNode {
    const start = this._lexer.token;
    const item = () => this.parseObjectField(isConst);
    return {
      type: Kind.OBJECT,
      fields: this.any(TokenKind.BRACE_L, item, TokenKind.BRACE_R),
      ...this.loc(start),
    };
  }

  /**
   * ObjectField[Const] : Name : Value[?Const]
   */
  parseObjectField(isConst: boolean): GraphQLESTree.ObjectFieldNode {
    const start = this._lexer.token;
    const name = this.parseName();
    this.expectToken(TokenKind.COLON);

    return {
      type: Kind.OBJECT_FIELD,
      name,
      value: this.parseValueLiteral(isConst),
      ...this.loc(start),
    };
  }

  // Implements the parsing rules in the Directives section.

  /**
   * Directives[Const] : Directive[?Const]+
   */
  parseDirectives(isConst: boolean): Array<GraphQLESTree.DirectiveNode> {
    const directives = [];
    while (this.peek(TokenKind.AT)) {
      directives.push(this.parseDirective(isConst));
    }
    return directives;
  }

  /**
   * Directive[Const] : @ Name Arguments[?Const]?
   */
  parseDirective(isConst: boolean): GraphQLESTree.DirectiveNode {
    const start = this._lexer.token;
    this.expectToken(TokenKind.AT);
    return {
      type: Kind.DIRECTIVE,
      name: this.parseName(),
      arguments: this.parseArguments(isConst),
      ...this.loc(start),
    };
  }

  // Implements the parsing rules in the Types section.

  /**
   * Type :
   *   - NamedType
   *   - ListType
   *   - NonNullType
   */
  parseTypeReference(): GraphQLESTree.TypeNode {
    const start = this._lexer.token;
    let type;
    if (this.expectOptionalToken(TokenKind.BRACKET_L)) {
      type = this.parseTypeReference();
      this.expectToken(TokenKind.BRACKET_R);
      type = {
        type: Kind.LIST_TYPE,
        ofType: type,
        ...this.loc(start),
      };
    } else {
      type = this.parseNamedType();
    }

    if (this.expectOptionalToken(TokenKind.BANG)) {
      return {
        type: Kind.NON_NULL_TYPE,
        ofType: type,
        ...this.loc(start),
      };
    }
    return type;
  }

  /**
   * NamedType : Name
   */
  parseNamedType(): GraphQLESTree.NamedTypeNode {
    const start = this._lexer.token;
    return {
      type: Kind.NAMED_TYPE,
      name: this.parseName(),
      ...this.loc(start),
    };
  }

  // Implements the parsing rules in the Type Definition section.

  /**
   * TypeSystemDefinition :
   *   - SchemaDefinition
   *   - TypeDefinition
   *   - DirectiveDefinition
   *
   * TypeDefinition :
   *   - ScalarTypeDefinition
   *   - ObjectTypeDefinition
   *   - InterfaceTypeDefinition
   *   - UnionTypeDefinition
   *   - EnumTypeDefinition
   *   - InputObjectTypeDefinition
   */
  parseTypeSystemDefinition(): GraphQLESTree.TypeSystemDefinitionNode {
    // Many definitions begin with a description and require a lookahead.
    const keywordToken = this.peekDescription()
      ? this._lexer.lookahead()
      : this._lexer.token;

    if (keywordToken.kind === TokenKind.NAME) {
      switch (keywordToken.value) {
        case "schema":
          return this.parseSchemaDefinition();
        case "scalar":
          return this.parseScalarTypeDefinition();
        case "type":
          return this.parseObjectTypeDefinition();
        case "interface":
          return this.parseInterfaceTypeDefinition();
        case "union":
          return this.parseUnionTypeDefinition();
        case "enum":
          return this.parseEnumTypeDefinition();
        case "input":
          return this.parseInputObjectTypeDefinition();
        case "directive":
          return this.parseDirectiveDefinition();
      }
    }

    throw this.unexpected(keywordToken);
  }

  peekDescription(): boolean {
    return this.peek(TokenKind.STRING) || this.peek(TokenKind.BLOCK_STRING);
  }

  /**
   * Description : StringValue
   */
  parseDescription(): Comment[] {
    if (this.peekDescription()) {
      const comment = this.parseStringLiteral();

      return [
        {
          type: comment.block ? "Block" : "Line",
          value: comment.value,
        },
      ];
    }

    return [];
  }

  /**
   * SchemaDefinition : Description? schema Directives[Const]? { OperationTypeDefinition+ }
   */
  parseSchemaDefinition(): GraphQLESTree.SchemaDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    this.expectKeyword("schema");
    const directives = this.parseDirectives(true);
    const operationTypes = this.many(
      TokenKind.BRACE_L,
      this.parseOperationTypeDefinition,
      TokenKind.BRACE_R
    );
    return {
      type: Kind.SCHEMA_DEFINITION,
      leadingComments: description,
      directives,
      operationTypes,
      ...this.loc(start),
    };
  }

  /**
   * OperationTypeDefinition : OperationType : NamedType
   */
  parseOperationTypeDefinition(): GraphQLESTree.OperationTypeDefinitionNode {
    const start = this._lexer.token;
    const operation = this.parseOperationType();
    this.expectToken(TokenKind.COLON);
    const type = this.parseNamedType();
    return {
      type: Kind.OPERATION_TYPE_DEFINITION,
      operation,
      ofType: type,
      ...this.loc(start),
    };
  }

  /**
   * ScalarTypeDefinition : Description? scalar Name Directives[Const]?
   */
  parseScalarTypeDefinition(): GraphQLESTree.ScalarTypeDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    this.expectKeyword("scalar");
    const name = this.parseName();
    const directives = this.parseDirectives(true);
    return {
      type: Kind.SCALAR_TYPE_DEFINITION,
      leadingComments: description,
      name,
      directives,
      ...this.loc(start),
    };
  }

  /**
   * ObjectTypeDefinition :
   *   Description?
   *   type Name ImplementsInterfaces? Directives[Const]? FieldsDefinition?
   */
  parseObjectTypeDefinition(): GraphQLESTree.ObjectTypeDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    this.expectKeyword("type");
    const name = this.parseName();
    const interfaces = this.parseImplementsInterfaces();
    const directives = this.parseDirectives(true);
    const fields = this.parseFieldsDefinition();
    return {
      type: Kind.OBJECT_TYPE_DEFINITION,
      leadingComments: description,
      name,
      interfaces,
      directives,
      fields,
      ...this.loc(start),
    };
  }

  /**
   * ImplementsInterfaces :
   *   - implements `&`? NamedType
   *   - ImplementsInterfaces & NamedType
   */
  parseImplementsInterfaces(): Array<GraphQLESTree.NamedTypeNode> {
    if (!this.expectOptionalKeyword("implements")) {
      return [];
    }

    if (this._options?.allowLegacySDLImplementsInterfaces === true) {
      const types = [];
      // Optional leading ampersand
      this.expectOptionalToken(TokenKind.AMP);
      do {
        types.push(this.parseNamedType());
      } while (
        this.expectOptionalToken(TokenKind.AMP) ||
        this.peek(TokenKind.NAME)
      );
      return types;
    }

    return this.delimitedMany(TokenKind.AMP, this.parseNamedType);
  }

  /**
   * FieldsDefinition : { FieldDefinition+ }
   */
  parseFieldsDefinition(): Array<GraphQLESTree.FieldDefinitionNode> {
    // Legacy support for the SDL?
    if (
      this._options?.allowLegacySDLEmptyFields === true &&
      this.peek(TokenKind.BRACE_L) &&
      this._lexer.lookahead().kind === TokenKind.BRACE_R
    ) {
      this._lexer.advance();
      this._lexer.advance();
      return [];
    }
    return this.optionalMany(
      TokenKind.BRACE_L,
      this.parseFieldDefinition,
      TokenKind.BRACE_R
    );
  }

  /**
   * FieldDefinition :
   *   - Description? Name ArgumentsDefinition? : Type Directives[Const]?
   */
  parseFieldDefinition(): GraphQLESTree.FieldDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    const name = this.parseName();
    const args = this.parseArgumentDefs();
    this.expectToken(TokenKind.COLON);
    const type = this.parseTypeReference();
    const directives = this.parseDirectives(true);
    return {
      type: Kind.FIELD_DEFINITION,
      leadingComments: description,
      name,
      arguments: args,
      ofType: type,
      directives,
      ...this.loc(start),
    };
  }

  /**
   * ArgumentsDefinition : ( InputValueDefinition+ )
   */
  parseArgumentDefs(): Array<GraphQLESTree.InputValueDefinitionNode> {
    return this.optionalMany(
      TokenKind.PAREN_L,
      this.parseInputValueDef,
      TokenKind.PAREN_R
    );
  }

  /**
   * InputValueDefinition :
   *   - Description? Name : Type DefaultValue? Directives[Const]?
   */
  parseInputValueDef(): GraphQLESTree.InputValueDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    const name = this.parseName();
    this.expectToken(TokenKind.COLON);
    const type = this.parseTypeReference();
    let defaultValue;
    if (this.expectOptionalToken(TokenKind.EQUALS)) {
      defaultValue = this.parseValueLiteral(true);
    }
    const directives = this.parseDirectives(true);
    return {
      type: Kind.INPUT_VALUE_DEFINITION,
      leadingComments: description,
      name,
      ofType: type,
      defaultValue,
      directives,
      ...this.loc(start),
    };
  }

  /**
   * InterfaceTypeDefinition :
   *   - Description? interface Name Directives[Const]? FieldsDefinition?
   */
  parseInterfaceTypeDefinition(): GraphQLESTree.InterfaceTypeDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    this.expectKeyword("interface");
    const name = this.parseName();
    const interfaces = this.parseImplementsInterfaces();
    const directives = this.parseDirectives(true);
    const fields = this.parseFieldsDefinition();
    return {
      type: Kind.INTERFACE_TYPE_DEFINITION,
      leadingComments: description,
      name,
      interfaces,
      directives,
      fields,
      ...this.loc(start),
    };
  }

  /**
   * UnionTypeDefinition :
   *   - Description? union Name Directives[Const]? UnionMemberTypes?
   */
  parseUnionTypeDefinition(): GraphQLESTree.UnionTypeDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    this.expectKeyword("union");
    const name = this.parseName();
    const directives = this.parseDirectives(true);
    const types = this.parseUnionMemberTypes();
    return {
      type: Kind.UNION_TYPE_DEFINITION,
      leadingComments: description,
      name,
      directives,
      types,
      ...this.loc(start),
    };
  }

  /**
   * UnionMemberTypes :
   *   - = `|`? NamedType
   *   - UnionMemberTypes | NamedType
   */
  parseUnionMemberTypes(): Array<GraphQLESTree.NamedTypeNode> {
    return this.expectOptionalToken(TokenKind.EQUALS)
      ? this.delimitedMany(TokenKind.PIPE, this.parseNamedType)
      : [];
  }

  /**
   * EnumTypeDefinition :
   *   - Description? enum Name Directives[Const]? EnumValuesDefinition?
   */
  parseEnumTypeDefinition(): GraphQLESTree.EnumTypeDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    this.expectKeyword("enum");
    const name = this.parseName();
    const directives = this.parseDirectives(true);
    const values = this.parseEnumValuesDefinition();
    return {
      type: Kind.ENUM_TYPE_DEFINITION,
      leadingComments: description,
      name,
      directives,
      values,
      ...this.loc(start),
    };
  }

  /**
   * EnumValuesDefinition : { EnumValueDefinition+ }
   */
  parseEnumValuesDefinition(): Array<GraphQLESTree.EnumValueDefinitionNode> {
    return this.optionalMany(
      TokenKind.BRACE_L,
      this.parseEnumValueDefinition,
      TokenKind.BRACE_R
    );
  }

  /**
   * EnumValueDefinition : Description? EnumValue Directives[Const]?
   *
   * EnumValue : Name
   */
  parseEnumValueDefinition(): GraphQLESTree.EnumValueDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    const name = this.parseName();
    const directives = this.parseDirectives(true);
    return {
      type: Kind.ENUM_VALUE_DEFINITION,
      leadingComments: description,
      name,
      directives,
      ...this.loc(start),
    };
  }

  /**
   * InputObjectTypeDefinition :
   *   - Description? input Name Directives[Const]? InputFieldsDefinition?
   */
  parseInputObjectTypeDefinition(): GraphQLESTree.InputObjectTypeDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    this.expectKeyword("input");
    const name = this.parseName();
    const directives = this.parseDirectives(true);
    const fields = this.parseInputFieldsDefinition();
    return {
      type: Kind.INPUT_OBJECT_TYPE_DEFINITION,
      leadingComments: description,
      name,
      directives,
      fields,
      ...this.loc(start),
    };
  }

  /**
   * InputFieldsDefinition : { InputValueDefinition+ }
   */
  parseInputFieldsDefinition(): Array<GraphQLESTree.InputValueDefinitionNode> {
    return this.optionalMany(
      TokenKind.BRACE_L,
      this.parseInputValueDef,
      TokenKind.BRACE_R
    );
  }

  /**
   * TypeSystemExtension :
   *   - SchemaExtension
   *   - TypeExtension
   *
   * TypeExtension :
   *   - ScalarTypeExtension
   *   - ObjectTypeExtension
   *   - InterfaceTypeExtension
   *   - UnionTypeExtension
   *   - EnumTypeExtension
   *   - InputObjectTypeDefinition
   */
  parseTypeSystemExtension(): GraphQLESTree.TypeSystemExtensionNode {
    const keywordToken = this._lexer.lookahead();

    if (keywordToken.kind === TokenKind.NAME) {
      switch (keywordToken.value) {
        case "schema":
          return this.parseSchemaExtension();
        case "scalar":
          return this.parseScalarTypeExtension();
        case "type":
          return this.parseObjectTypeExtension();
        case "interface":
          return this.parseInterfaceTypeExtension();
        case "union":
          return this.parseUnionTypeExtension();
        case "enum":
          return this.parseEnumTypeExtension();
        case "input":
          return this.parseInputObjectTypeExtension();
      }
    }

    throw this.unexpected(keywordToken);
  }

  /**
   * SchemaExtension :
   *  - extend schema Directives[Const]? { OperationTypeDefinition+ }
   *  - extend schema Directives[Const]
   */
  parseSchemaExtension(): GraphQLESTree.SchemaExtensionNode {
    const start = this._lexer.token;
    this.expectKeyword("extend");
    this.expectKeyword("schema");
    const directives = this.parseDirectives(true);
    const operationTypes = this.optionalMany(
      TokenKind.BRACE_L,
      this.parseOperationTypeDefinition,
      TokenKind.BRACE_R
    );
    if (directives.length === 0 && operationTypes.length === 0) {
      throw this.unexpected();
    }
    return {
      type: Kind.SCHEMA_EXTENSION,
      directives,
      operationTypes,
      ...this.loc(start),
    };
  }

  /**
   * ScalarTypeExtension :
   *   - extend scalar Name Directives[Const]
   */
  parseScalarTypeExtension(): GraphQLESTree.ScalarTypeExtensionNode {
    const start = this._lexer.token;
    this.expectKeyword("extend");
    this.expectKeyword("scalar");
    const name = this.parseName();
    const directives = this.parseDirectives(true);
    if (directives.length === 0) {
      throw this.unexpected();
    }
    return {
      type: Kind.SCALAR_TYPE_EXTENSION,
      name,
      directives,
      ...this.loc(start),
    };
  }

  /**
   * ObjectTypeExtension :
   *  - extend type Name ImplementsInterfaces? Directives[Const]? FieldsDefinition
   *  - extend type Name ImplementsInterfaces? Directives[Const]
   *  - extend type Name ImplementsInterfaces
   */
  parseObjectTypeExtension(): GraphQLESTree.ObjectTypeExtensionNode {
    const start = this._lexer.token;
    this.expectKeyword("extend");
    this.expectKeyword("type");
    const name = this.parseName();
    const interfaces = this.parseImplementsInterfaces();
    const directives = this.parseDirectives(true);
    const fields = this.parseFieldsDefinition();
    if (
      interfaces.length === 0 &&
      directives.length === 0 &&
      fields.length === 0
    ) {
      throw this.unexpected();
    }
    return {
      type: Kind.OBJECT_TYPE_EXTENSION,
      name,
      interfaces,
      directives,
      fields,
      ...this.loc(start),
    };
  }

  /**
   * InterfaceTypeExtension :
   *  - extend interface Name ImplementsInterfaces? Directives[Const]? FieldsDefinition
   *  - extend interface Name ImplementsInterfaces? Directives[Const]
   *  - extend interface Name ImplementsInterfaces
   */
  parseInterfaceTypeExtension(): GraphQLESTree.InterfaceTypeExtensionNode {
    const start = this._lexer.token;
    this.expectKeyword("extend");
    this.expectKeyword("interface");
    const name = this.parseName();
    const interfaces = this.parseImplementsInterfaces();
    const directives = this.parseDirectives(true);
    const fields = this.parseFieldsDefinition();
    if (
      interfaces.length === 0 &&
      directives.length === 0 &&
      fields.length === 0
    ) {
      throw this.unexpected();
    }
    return {
      type: Kind.INTERFACE_TYPE_EXTENSION,
      name,
      interfaces,
      directives,
      fields,
      ...this.loc(start),
    };
  }

  /**
   * UnionTypeExtension :
   *   - extend union Name Directives[Const]? UnionMemberTypes
   *   - extend union Name Directives[Const]
   */
  parseUnionTypeExtension(): GraphQLESTree.UnionTypeExtensionNode {
    const start = this._lexer.token;
    this.expectKeyword("extend");
    this.expectKeyword("union");
    const name = this.parseName();
    const directives = this.parseDirectives(true);
    const types = this.parseUnionMemberTypes();
    if (directives.length === 0 && types.length === 0) {
      throw this.unexpected();
    }
    return {
      type: Kind.UNION_TYPE_EXTENSION,
      name,
      directives,
      types,
      ...this.loc(start),
    };
  }

  /**
   * EnumTypeExtension :
   *   - extend enum Name Directives[Const]? EnumValuesDefinition
   *   - extend enum Name Directives[Const]
   */
  parseEnumTypeExtension(): GraphQLESTree.EnumTypeExtensionNode {
    const start = this._lexer.token;
    this.expectKeyword("extend");
    this.expectKeyword("enum");
    const name = this.parseName();
    const directives = this.parseDirectives(true);
    const values = this.parseEnumValuesDefinition();
    if (directives.length === 0 && values.length === 0) {
      throw this.unexpected();
    }
    return {
      type: Kind.ENUM_TYPE_EXTENSION,
      name,
      directives,
      values,
      ...this.loc(start),
    };
  }

  /**
   * InputObjectTypeExtension :
   *   - extend input Name Directives[Const]? InputFieldsDefinition
   *   - extend input Name Directives[Const]
   */
  parseInputObjectTypeExtension(): GraphQLESTree.InputObjectTypeExtensionNode {
    const start = this._lexer.token;
    this.expectKeyword("extend");
    this.expectKeyword("input");
    const name = this.parseName();
    const directives = this.parseDirectives(true);
    const fields = this.parseInputFieldsDefinition();
    if (directives.length === 0 && fields.length === 0) {
      throw this.unexpected();
    }
    return {
      type: Kind.INPUT_OBJECT_TYPE_EXTENSION,
      name,
      directives,
      fields,
      ...this.loc(start),
    };
  }

  /**
   * DirectiveDefinition :
   *   - Description? directive @ Name ArgumentsDefinition? `repeatable`? on DirectiveLocations
   */
  parseDirectiveDefinition(): GraphQLESTree.DirectiveDefinitionNode {
    const start = this._lexer.token;
    const description = this.parseDescription();
    this.expectKeyword("directive");
    this.expectToken(TokenKind.AT);
    const name = this.parseName();
    const args = this.parseArgumentDefs();
    const repeatable = this.expectOptionalKeyword("repeatable");
    this.expectKeyword("on");
    const locations = this.parseDirectiveLocations();
    return {
      type: Kind.DIRECTIVE_DEFINITION,
      leadingComments: description,
      name,
      arguments: args,
      repeatable,
      locations,
      ...this.loc(start),
    };
  }

  /**
   * DirectiveLocations :
   *   - `|`? DirectiveLocation
   *   - DirectiveLocations | DirectiveLocation
   */
  parseDirectiveLocations(): Array<GraphQLESTree.NameNode> {
    return this.delimitedMany(TokenKind.PIPE, this.parseDirectiveLocation);
  }

  /*
   * DirectiveLocation :
   *   - ExecutableDirectiveLocation
   *   - TypeSystemDirectiveLocation
   *
   * ExecutableDirectiveLocation : one of
   *   `QUERY`
   *   `MUTATION`
   *   `SUBSCRIPTION`
   *   `FIELD`
   *   `FRAGMENT_DEFINITION`
   *   `FRAGMENT_SPREAD`
   *   `INLINE_FRAGMENT`
   *
   * TypeSystemDirectiveLocation : one of
   *   `SCHEMA`
   *   `SCALAR`
   *   `OBJECT`
   *   `FIELD_DEFINITION`
   *   `ARGUMENT_DEFINITION`
   *   `INTERFACE`
   *   `UNION`
   *   `ENUM`
   *   `ENUM_VALUE`
   *   `INPUT_OBJECT`
   *   `INPUT_FIELD_DEFINITION`
   */
  parseDirectiveLocation(): GraphQLESTree.NameNode {
    const start = this._lexer.token;
    const name = this.parseName();
    if (DirectiveLocation[name.value] !== undefined) {
      return name;
    }
    throw this.unexpected(start);
  }

  // Core parsing utility functions

  /**
   * Returns a location object, used to identify the place in the source that created a given parsed object.
   */
  loc(startToken: Token): { range?: BaseNode["range"]; loc?: BaseNode["loc"] } {
    if (this._options?.noLocation !== true) {
      const gqlLocation = new GraphQLLocation(
        startToken,
        this._lexer.lastToken,
        this._lexer.source
      );

      return {
        range: [gqlLocation.start, gqlLocation.end],
        loc: {
          start: {
            column: gqlLocation.startToken.column,
            line: gqlLocation.startToken.line,
          },
          end: {
            column: gqlLocation.endToken.column,
            line: gqlLocation.endToken.line,
          },
          source: gqlLocation.source.body,
        },
      };
    }

    return {};
  }

  /**
   * Determines if the next token is of a given kind
   */
  peek(kind: TokenKindEnum): boolean {
    return this._lexer.token.kind === kind;
  }

  /**
   * If the next token is of the given kind, return that token after advancing the lexer.
   * Otherwise, do not change the parser state and throw an error.
   */
  expectToken(kind: TokenKindEnum): Token {
    const token = this._lexer.token;
    if (token.kind === kind) {
      this._lexer.advance();
      return token;
    }

    throw syntaxError(
      this._lexer.source,
      token.start,
      `Expected ${getTokenKindDesc(kind)}, found ${getTokenDesc(token)}.`
    );
  }

  /**
   * If the next token is of the given kind, return that token after advancing the lexer.
   * Otherwise, do not change the parser state and return undefined.
   */
  expectOptionalToken(kind: TokenKindEnum): Token {
    const token = this._lexer.token;
    if (token.kind === kind) {
      this._lexer.advance();
      return token;
    }
    return undefined;
  }

  /**
   * If the next token is a given keyword, advance the lexer.
   * Otherwise, do not change the parser state and throw an error.
   */
  expectKeyword(value: string): void {
    const token = this._lexer.token;
    if (token.kind === TokenKind.NAME && token.value === value) {
      this._lexer.advance();
    } else {
      throw syntaxError(
        this._lexer.source,
        token.start,
        `Expected "${value}", found ${getTokenDesc(token)}.`
      );
    }
  }

  /**
   * If the next token is a given keyword, return "true" after advancing the lexer.
   * Otherwise, do not change the parser state and return "false".
   */
  expectOptionalKeyword(value: string): boolean {
    const token = this._lexer.token;
    if (token.kind === TokenKind.NAME && token.value === value) {
      this._lexer.advance();
      return true;
    }
    return false;
  }

  /**
   * Helper function for creating an error when an unexpected lexed token is encountered.
   */
  unexpected(atToken?: Token): GraphQLError {
    const token = atToken ?? this._lexer.token;
    return syntaxError(
      this._lexer.source,
      token.start,
      `Unexpected ${getTokenDesc(token)}.`
    );
  }

  /**
   * Returns a possibly empty list of parse nodes, determined by the parseFn.
   * This list begins with a lex token of openKind and ends with a lex token of closeKind.
   * Advances the parser to the next lex token after the closing token.
   */
  any<T>(
    openKind: TokenKindEnum,
    parseFn: () => T,
    closeKind: TokenKindEnum
  ): Array<T> {
    this.expectToken(openKind);
    const nodes = [];
    while (!this.expectOptionalToken(closeKind)) {
      nodes.push(parseFn.call(this));
    }
    return nodes;
  }

  /**
   * Returns a list of parse nodes, determined by the parseFn.
   * It can be empty only if open token is missing otherwise it will always return non-empty list
   * that begins with a lex token of openKind and ends with a lex token of closeKind.
   * Advances the parser to the next lex token after the closing token.
   */
  optionalMany<T>(
    openKind: TokenKindEnum,
    parseFn: () => T,
    closeKind: TokenKindEnum
  ): Array<T> {
    if (this.expectOptionalToken(openKind)) {
      const nodes = [];
      do {
        nodes.push(parseFn.call(this));
      } while (!this.expectOptionalToken(closeKind));
      return nodes;
    }
    return [];
  }

  /**
   * Returns a non-empty list of parse nodes, determined by the parseFn.
   * This list begins with a lex token of openKind and ends with a lex token of closeKind.
   * Advances the parser to the next lex token after the closing token.
   */
  many<T>(
    openKind: TokenKindEnum,
    parseFn: () => T,
    closeKind: TokenKindEnum
  ): Array<T> {
    this.expectToken(openKind);
    const nodes = [];
    do {
      nodes.push(parseFn.call(this));
    } while (!this.expectOptionalToken(closeKind));
    return nodes;
  }

  /**
   * Returns a non-empty list of parse nodes, determined by the parseFn.
   * This list may begin with a lex token of delimiterKind followed by items separated by lex tokens of tokenKind.
   * Advances the parser to the next lex token after last item in the list.
   */
  delimitedMany<T>(delimiterKind: TokenKindEnum, parseFn: () => T): Array<T> {
    this.expectOptionalToken(delimiterKind);

    const nodes = [];
    do {
      nodes.push(parseFn.call(this));
    } while (this.expectOptionalToken(delimiterKind));
    return nodes;
  }
}

/**
 * A helper function to describe a token as a string for debugging.
 */
function getTokenDesc(token: Token): string {
  const value = token.value;
  return getTokenKindDesc(token.kind) + (value != null ? ` "${value}"` : "");
}

/**
 * A helper function to describe a token kind as a string for debugging.
 */
function getTokenKindDesc(kind: TokenKindEnum): string {
  return isPunctuatorTokenKind(kind) ? `"${kind}"` : kind;
}
