import { Context, Data, Effect, Layer, Option } from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

export class Error extends Data.TaggedError("Auth.Error")<{
  readonly cause: unknown;
}> {}

export interface Interface {
  readonly getSession: (
    providerId: "github" | "microsoft",
    scopes: readonly string[],
    options: vscode.AuthenticationGetSessionOptions,
  ) => Effect.Effect<Option.Option<vscode.AuthenticationSession>, Error>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/Auth",
) {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const api = vscode.authentication;

    const getSession = Effect.fn("Auth.getSession")(function* (
      providerId: "github" | "microsoft",
      scopes: readonly string[],
      options: vscode.AuthenticationGetSessionOptions,
    ) {
      return Option.fromNullishOr(
        yield* Effect.tryPromise({
          try: () => api.getSession(providerId, scopes, options),
          catch: (cause) => new Error({ cause }),
        }),
      );
    });

    return Service.of({ getSession });
  }),
);
