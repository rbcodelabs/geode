import { Token, TokenType, scanRegexLiteral, tokenize } from "./lexer";
import { BinaryOp, Expr, PropertyRoot } from "./ast";

const KNOWN_ROOTS: ReadonlySet<string> = new Set(["note", "file", "formula", "this"]);

/**
 * Recursive-descent parser. Never throws — `parseExpression()` is the only
 * public entry point and always returns a result object. Internal parse
 * methods record problems on `errors` and fall back to a harmless
 * placeholder node so parsing can always finish (no exceptions, no infinite
 * loops).
 *
 * Precedence (low to high), per the spec:
 *   or < and < unary "not" < comparison (non-chainable) < additive
 *   < multiplicative < unary (-, +) < postfix (., (), [])
 */
class Parser {
  pos = 0;
  errors: string[] = [];

  constructor(
    private tokens: Token[],
    private source: string
  ) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private check(type: TokenType, offset = 0): boolean {
    return this.peek(offset).type === type;
  }

  private advance(): Token {
    const t = this.peek();
    if (t.type !== "eof") this.pos++;
    return t;
  }

  isAtEnd(): boolean {
    return this.check("eof");
  }

  private error(msg: string) {
    this.errors.push(msg);
  }

  private placeholder(): Expr {
    return { kind: "literal", value: false };
  }

  // --- Precedence ladder ----------------------------------------------------

  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.check("or")) {
      this.advance();
      const right = this.parseAnd();
      left = this.binary("or", left, right);
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.check("and")) {
      this.advance();
      const right = this.parseNot();
      left = this.binary("and", left, right);
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.check("not")) {
      this.advance();
      const operand = this.parseNot();
      return { kind: "unary", op: "not", operand };
    }
    return this.parseComparison();
  }

  /** Comparisons are non-associative: at most one comparison operator per level. */
  private parseComparison(): Expr {
    const left = this.parseAdditive();
    const opType = this.peek().type;
    const opMap: Partial<Record<TokenType, BinaryOp>> = {
      eq: "==",
      neq: "!=",
      gt: ">",
      lt: "<",
      gte: ">=",
      lte: "<=",
    };
    const op = opMap[opType];
    if (op) {
      this.advance();
      const right = this.parseAdditive();
      return this.binary(op, left, right);
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.check("plus")) {
        this.advance();
        left = this.binary("+", left, this.parseMultiplicative());
      } else if (this.check("minus")) {
        this.advance();
        left = this.binary("-", left, this.parseMultiplicative());
      } else {
        break;
      }
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnaryPlusMinus();
    for (;;) {
      if (this.check("star")) {
        this.advance();
        left = this.binary("*", left, this.parseUnaryPlusMinus());
      } else if (this.check("slash")) {
        this.advance();
        left = this.binary("/", left, this.parseUnaryPlusMinus());
      } else if (this.check("percent")) {
        this.advance();
        left = this.binary("%", left, this.parseUnaryPlusMinus());
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnaryPlusMinus(): Expr {
    if (this.check("minus")) {
      this.advance();
      return { kind: "unary", op: "-", operand: this.parseUnaryPlusMinus() };
    }
    if (this.check("plus")) {
      this.advance();
      return { kind: "unary", op: "+", operand: this.parseUnaryPlusMinus() };
    }
    return this.postfix();
  }

  private binary(op: BinaryOp, left: Expr, right: Expr): Expr {
    return { kind: "binary", op, left, right };
  }

  // --- Postfix / primary -----------------------------------------------------

  private postfix(): Expr {
    let expr: Expr;
    if (this.check("identifier")) {
      expr = this.identifierLead();
    } else {
      expr = this.primary();
    }
    return this.continuePostfix(expr);
  }

  /**
   * Handles a leading bare identifier per the spec's disambiguation rule:
   * `name(` is a call; otherwise it's the start of a property path, folding
   * `.segment` chain entries into `segments` until one is immediately
   * followed by `(` (which becomes a methodCall wrapping the propertyPath
   * accumulated so far) or the dot-chain simply ends.
   */
  private identifierLead(): Expr {
    const idTok = this.advance();
    const name = idTok.text;

    if (this.check("lparen")) {
      return { kind: "call", callee: name, args: this.parseArgs() };
    }

    let root: PropertyRoot = "shorthand";
    const segments: string[] = [];
    if (KNOWN_ROOTS.has(name)) {
      root = name as PropertyRoot;
    } else {
      segments.push(name);
    }

    while (this.check("dot") && this.check("identifier", 1)) {
      this.advance(); // dot
      const segTok = this.advance(); // identifier
      if (this.check("lparen")) {
        const args = this.parseArgs();
        return {
          kind: "methodCall",
          target: { kind: "propertyPath", root, segments },
          method: segTok.text,
          args,
        };
      }
      segments.push(segTok.text);
    }

    return { kind: "propertyPath", root, segments };
  }

  /** Handles further `.field` / `.method(args)` / `[index]` chaining on top of any expr. */
  private continuePostfix(expr: Expr): Expr {
    for (;;) {
      if (this.check("dot") && this.check("identifier", 1)) {
        this.advance();
        const segTok = this.advance();
        if (this.check("lparen")) {
          expr = { kind: "methodCall", target: expr, method: segTok.text, args: this.parseArgs() };
        } else {
          expr = { kind: "fieldAccess", target: expr, field: segTok.text };
        }
      } else if (this.check("lbracket")) {
        this.advance();
        const indexExpr = this.parseOr();
        if (!this.check("rbracket")) {
          this.error(`Expected "]" at position ${this.peek().start}`);
        } else {
          this.advance();
        }
        expr = { kind: "index", target: expr, indexExpr };
      } else {
        break;
      }
    }
    return expr;
  }

  private parseArgs(): Expr[] {
    // current token is "lparen"
    this.advance();
    const args: Expr[] = [];
    if (!this.check("rparen")) {
      args.push(this.parseOr());
      while (this.check("comma")) {
        this.advance();
        args.push(this.parseOr());
      }
    }
    if (!this.check("rparen")) {
      this.error(`Expected ")" at position ${this.peek().start}`);
    } else {
      this.advance();
    }
    return args;
  }

  private primary(): Expr {
    const tok = this.peek();

    switch (tok.type) {
      case "lparen": {
        this.advance();
        const inner = this.parseOr();
        if (!this.check("rparen")) {
          this.error(`Expected ")" at position ${this.peek().start}`);
        } else {
          this.advance();
        }
        return { kind: "group", inner };
      }
      case "number":
        this.advance();
        return { kind: "literal", value: tok.value as number };
      case "string":
        this.advance();
        return { kind: "literal", value: tok.value as string };
      case "true":
        this.advance();
        return { kind: "literal", value: true };
      case "false":
        this.advance();
        return { kind: "literal", value: false };
      case "slash": {
        const scanned = scanRegexLiteral(this.source, tok.start);
        if (!scanned) {
          this.error(`Unterminated regex literal at position ${tok.start}`);
          this.advance();
          return this.placeholder();
        }
        // Re-sync the token stream past the regex span (the original
        // tokenization inside that span used ordinary rules and is unused).
        let idx = this.pos;
        while (idx < this.tokens.length - 1 && this.tokens[idx].start < scanned.end) idx++;
        this.pos = idx;
        return { kind: "regexLiteral", source: scanned.source, flags: scanned.flags };
      }
      default:
        this.error(`Unexpected token "${tok.text || tok.type}" at position ${tok.start}`);
        if (!this.isAtEnd()) this.advance();
        return this.placeholder();
    }
  }
}

/**
 * Parse a single Bases expression string into an AST. Never throws —
 * malformed input returns `{ error }` instead of `{ expr }`.
 */
export function parseExpression(source: string): { expr: Expr } | { error: string } {
  try {
    const tokens = tokenize(source);
    const parser = new Parser(tokens, source);
    const expr = parser.parseOr();
    if (parser.errors.length) {
      return { error: parser.errors[0] };
    }
    if (!parser.isAtEnd()) {
      const tok = parser.peek();
      return { error: `Unexpected trailing input "${tok.text || tok.type}" at position ${tok.start}` };
    }
    return { expr };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
