// Compile-time regression tests, checked by `npm run typecheck`, never executed.
// Expected-error directives are intentional: weakening a constraint makes tsc fail.
import type { ExtensionContext, RpcClient } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, parseSubagentInput } from "../src/config.ts";
import type {
  ParsedSendInput, PromptDisposition, ResolvedChildConfig, SendInput,
  SpawnInput, SubagentInput, ThinkingLevel,
} from "../src/types.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type ThinkingLevelsMatchSdk = Assert<Equal<
  typeof THINKING_LEVELS[number], NonNullable<ExtensionContext["thinkingLevel"]>
>>;
export type ThinkingTypeMatchesSdk = Assert<Equal<
  ThinkingLevel, NonNullable<ExtensionContext["thinkingLevel"]>
>>;
export type DispositionsMatchSdk = Assert<Equal<
  PromptDisposition, Awaited<ReturnType<RpcClient["prompt"]>>
>>;

export function checkInputConstraints(): void {
  const base = { action: "spawn", name: "reviewer", message: "review" } as const;
  const inherited: SpawnInput = base;
  const explicit: SpawnInput = { ...base, provider: "provider", model: "model" };
  const independentThinking: SpawnInput = { ...base, thinking: "high" };
  // @ts-expect-error A provider override without a model is invalid.
  const missingModel: SpawnInput = { ...base, provider: "provider" };
  // @ts-expect-error A model override without a provider is invalid.
  const missingProvider: SpawnInput = { ...base, model: "model" };
  // @ts-expect-error Explicit undefined cannot substitute for the missing paired model.
  const undefinedModel: SpawnInput = { ...base, provider: "provider", model: undefined };
  // @ts-expect-error Exact optional fields distinguish omission from undefined.
  const undefinedThinking: SpawnInput = { ...base, thinking: undefined };
  // @ts-expect-error Thinking levels must come from the SDK.
  const invalidThinking: SpawnInput = { ...base, thinking: "turbo" };
  // @ts-expect-error Send inputs do not accept spawn-only configuration.
  const sendConfig: SendInput = { action: "send", name: "reviewer", message: "next", provider: "provider" };
  const mixed = { action: "send", name: "reviewer", message: "next", provider: "provider", model: "model" } as const;
  // @ts-expect-error Forbidden action fields are rejected even through intermediate variables.
  const mixedInput: SubagentInput = mixed;
  // @ts-expect-error followUp belongs only to send.
  const spawnFollowUp: SpawnInput = { ...base, followUp: true };
  // @ts-expect-error Parsed sends always have a normalized followUp boolean.
  const unnormalized: ParsedSendInput = { action: "send", name: "reviewer", message: "next" };
  // @ts-expect-error Inputs are immutable after capture.
  inherited.name = "different";
  void [inherited, explicit, independentThinking, missingModel, missingProvider,
    undefinedModel, undefinedThinking, invalidThinking, sendConfig, mixedInput, spawnFollowUp, unnormalized];
}

export function checkNarrowing(input: SubagentInput, config: ResolvedChildConfig): void {
  if (input.action === "send") {
    const followUp: boolean | undefined = input.followUp;
    // @ts-expect-error Action narrowing excludes a usable spawn-only provider.
    const provider: string = input.provider;
    void [followUp, provider];
  } else if (input.provider !== undefined) {
    // Provider presence guarantees its paired model is present too.
    const model: string = input.model;
    void model;
  }
  const parsed = parseSubagentInput(input);
  if (parsed.action === "send") {
    const followUp: boolean = parsed.followUp;
    void followUp;
  }
  // @ts-expect-error Resolved child configuration is an immutable snapshot.
  config.model = "different";
}
