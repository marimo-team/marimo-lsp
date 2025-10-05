import {
  FetchHttpClient,
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "@effect/platform";
import { Effect, flow, Option, Schema } from "effect";
import { VsCode } from "./VsCode.ts";

const GistRequest = Schema.Struct({
  description: Schema.String,
  public: Schema.Boolean,
  files: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({ content: Schema.String }),
  }),
});

const GistResponse = Schema.Struct({
  id: Schema.String,
  html_url: Schema.String,
});

const GitHubApi = HttpApi.make("GitHubApi").add(
  HttpApiGroup.make("Gists").add(
    HttpApiEndpoint.post("create", "/gists")
      .setPayload(GistRequest)
      .addSuccess(GistResponse, { status: 201 }),
  ),
);

export class GitHubClient extends Effect.Service<GitHubClient>()(
  "GitHubClient",
  {
    dependencies: [FetchHttpClient.layer],
    effect: Effect.gen(function* () {
      const code = yield* VsCode;

      const client = yield* HttpApiClient.make(GitHubApi, {
        baseUrl: "https://api.github.com",
        transformClient: flow(
          HttpClient.mapRequest(HttpClientRequest.acceptJson),
          HttpClient.mapRequestEffect(
            Effect.fnUntraced(function* (request) {
              // lazily try to get session when making requests
              const session = yield* code.auth
                .getSession("github", ["gist"], { createIfNone: true })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new HttpClientError.RequestError({
                        request,
                        reason: "Transport",
                        cause,
                        description:
                          "Failed to get GitHub authentication session",
                      }),
                  ),
                );

              if (Option.isNone(session)) {
                return yield* new HttpClientError.RequestError({
                  request,
                  reason: "Transport",
                  description:
                    "GitHub authentication required. Please sign in to publish gists.",
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
) {}
