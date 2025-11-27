var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? (o, m, k, k2) => {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = { enumerable: true, get: () => m[k] };
        }
        Object.defineProperty(o, k2, desc);
      }
    : (o, m, k, k2) => {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __exportStar =
  (this && this.__exportStar) ||
  ((m, exports) => {
    for (var p in m)
      if (p !== "default" && !Object.hasOwn(exports, p))
        __createBinding(exports, m, p);
  });
Object.defineProperty(exports, "__esModule", { value: true });
exports.SemVerFromString = exports.MarimoNotebook = void 0;
const semver = require("@std/semver");
const effect_1 = require("effect");
__exportStar(require("./schemas/packages.ts"), exports);
__exportStar(require("./schemas/vscode-notebook.ts"), exports);
const Header = effect_1.Schema.Struct({
  value: effect_1.Schema.String.pipe(
    effect_1.Schema.optionalWith({ nullable: true }),
  ),
});
const AppInstantiation = effect_1.Schema.Struct({
  options: effect_1.Schema.Record({
    key: effect_1.Schema.String,
    value: effect_1.Schema.Unknown,
  }),
});
const CellDef = effect_1.Schema.Struct({
  code: effect_1.Schema.String,
  name: effect_1.Schema.String.pipe(
    effect_1.Schema.optionalWith({ nullable: true }),
    effect_1.Schema.withDecodingDefault(() => "_"),
  ),
  options: effect_1.Schema.Record({
    key: effect_1.Schema.String,
    value: effect_1.Schema.Unknown,
  }),
});
const Violation = effect_1.Schema.Struct({
  description: effect_1.Schema.String,
  lineno: effect_1.Schema.Int.pipe(
    effect_1.Schema.optionalWith({ nullable: true }),
    effect_1.Schema.withDecodingDefault(() => 0),
  ),
  col_offset: effect_1.Schema.Int.pipe(
    effect_1.Schema.optionalWith({ nullable: true }),
    effect_1.Schema.withDecodingDefault(() => 0),
  ),
});
/**
 * Our internal IR for a marimo notebook used to send over the wire
 */
exports.MarimoNotebook = effect_1.Schema.Struct({
  app: AppInstantiation,
  header: Header.pipe(effect_1.Schema.NullOr),
  version: effect_1.Schema.String.pipe(effect_1.Schema.NullOr),
  cells: effect_1.Schema.Array(CellDef),
  violations: effect_1.Schema.Array(Violation),
  valid: effect_1.Schema.Boolean,
});
exports.SemVerFromString = effect_1.Schema.transformOrFail(
  effect_1.Schema.String,
  effect_1.Schema.Struct({
    major: effect_1.Schema.Number,
    minor: effect_1.Schema.Number,
    patch: effect_1.Schema.Number,
  }),
  {
    decode: (from) => {
      const parsed = semver.tryParse(from);
      if (parsed) {
        return effect_1.ParseResult.succeed(parsed);
      }
      // some PyPI versions aren't valid
      const parsed2 = semver.tryParse(`${from}.0`);
      if (parsed2) {
        return effect_1.ParseResult.succeed(parsed2);
      }
      return effect_1.ParseResult.fail(
        new effect_1.ParseResult.Type(
          effect_1.Schema.String.ast,
          from,
          `Invalid semver string: ${from}`,
        ),
      );
    },
    encode: (to) => effect_1.ParseResult.succeed(semver.format(to)),
  },
);
