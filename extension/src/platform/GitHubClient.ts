import { Context, Effect, flow, Layer, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import {
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";

import { VsCode } from "./VsCode.ts";

const GistRequest = Schema.Struct({
  public: Schema.Boolean,
  files: Schema.Record(
    Schema.String,
    Schema.Struct({ content: Schema.String }),
  ),
});

const GistResponse = Schema.Struct({
  id: Schema.String,
  html_url: Schema.String,
});

const GistUpdateRequest = Schema.Struct({
  files: Schema.Record(
    Schema.String,
    Schema.Struct({ content: Schema.String }),
  ),
});

const GitHubApi = HttpApi.make("GitHubApi").add(
  HttpApiGroup.make("Gists").add(
    HttpApiEndpoint.post("create", "/gists", {
      payload: GistRequest,
      success: GistResponse.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.patch("update", "/gists/:id", {
      params: { id: Schema.String },
      payload: GistUpdateRequest,
      success: GistResponse,
    }),
  ),
);

export class GitHubClient extends Context.Service<GitHubClient>()(
  "GitHubClient",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;

      const client = yield* HttpApiClient.make(GitHubApi, {
        baseUrl: "https://api.github.com",
        transformClient: flow(
          HttpClient.mapRequest(HttpClientRequest.acceptJson),
          HttpClient.mapRequestEffect(
            Effect.fn(function* (request) {
              // lazily try to get session when making requests
              const session = yield* code.auth
                .getSession("github", ["gist"], { createIfNone: true })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({
                          request,
                          cause,
                          description:
                            "Failed to get GitHub authentication session",
                        }),
                      }),
                  ),
                );

              if (Option.isNone(session)) {
                return yield* new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    description:
                      "GitHub authentication required. Please sign in to publish gists.",
                  }),
                });
              }

              return HttpClientRequest.bearerToken(
                request,
                session.value.accessToken,
              );
            }),
          ),
        ),
      });

      return client;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
}
