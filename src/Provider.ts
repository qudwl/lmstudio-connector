import {
  CancellationToken,
  LanguageModelChatInformation,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  PrepareLanguageModelChatModelOptions,
  Progress,
  ProvideLanguageModelChatResponseOptions,
  Uri,
  workspace,
  Disposable,
} from "vscode";

import { toAbortSignal } from "./utils";
import { Chat, LMStudioClient } from "@lmstudio/sdk";

function getLMStudioConfig() {
  const config = workspace.getConfiguration("lmstudioConnector");
  return {
    port: config.get<number>("port", 1234),
    apiKey: config.get<string>("apiKey", ""),
  };
}

export class LMSConnectorProvider implements LanguageModelChatProvider {
  private client: LMStudioClient;
  private configListener: Disposable;
  private modelCache = new Map<
    string,
    Awaited<ReturnType<typeof this.client.llm.model>>
  >();

  constructor() {
    this.client = this.createClient();

    this.configListener = workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("lmstudioConnector")) {
        this.client = this.createClient();
        console.log("LM Studio client reloaded due to config change.");
      }
    });
  }

  /**
   * Creates a new LMStudioClient instance based on current configuration.
   *
   * @returns an instance of LMStudioClient connected to the specified LM Studio WebSocket API.
   */
  private createClient(): LMStudioClient {
    const config = workspace.getConfiguration("lmstudioConnector");
    const port = config.get<number>("port", 1234);
    const apiKey = config.get<string>("apiKey", "");
    return new LMStudioClient({
      baseUrl: `ws://127.0.0.1:${port}`,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  private async getModel(modelId: string) {
    if (this.modelCache.has(modelId)) {
      return this.modelCache.get(modelId)!;
    }
    const model = await this.client.llm.model(modelId);
    this.modelCache.set(modelId, model);
    return model;
  }

  /**
   * Provides a list of available language models from LM Studio.
   *
   * @param options Language model preparation options, including whether to operate in silent mode.
   * @param token Cancellation token to handle request cancellation.
   * @returns A promise that resolves to an array of LanguageModelChatInformation objects representing available models.
   */
  async provideLanguageModelChatInformation(
    options: PrepareLanguageModelChatModelOptions,
    token: CancellationToken,
  ) {
    // if (options.silent) {
    //   return []; // Don't prompt user in silent mode
    // } else {
    //   // await this.promptForApiKey(); // Prompt user for credentials
    // }

    try {
      const models = (await this.client.system.listDownloadedModels()).filter(
        (model) => model.type === "llm",
      );

      console.log(
        "LM Studio models found:",
        models.map((m) => m.displayName).join(", "),
      );

      return models.map((model) => ({
        id: model.modelKey,
        name: model.displayName,
        family: model.architecture || "Unknown",
        tooltip: `Model: ${model.displayName}\nArchitecture: ${model.architecture}`,
        maxInputTokens: model.maxContextLength,
        maxOutputTokens: 4096, // This is a placeholder; adjust based on model capabilities
        version: "1.0", // Placeholder version
        capabilities: {
          imageInput: !!model.vision,
          toolCalling: !!model.trainedForToolUse,
        },
      }));
    } catch (e) {
      console.warn("Failed to list LM Studio models. Is LM Studio running?", e);
      return [];
    }
  }

  /**
   * Helper: Converts VS Code messages to LM Studio's expected format.
   * Extracts text content from messages.
   */
  private async convertMessages(
    messages: readonly LanguageModelChatRequestMessage[],
  ) {
    return Promise.all(
      messages.map(async (msg) => {
        // Map Role
        let role: "user" | "assistant" = "user";
        if (msg.role === 2) {
          // LanguageModelChatRole.Assistant
          role = "assistant";
        }

        // Map Content - LM Studio SDK expects simple text content
        let content = "";

        if (typeof msg.content === "string") {
          content = msg.content;
        } else {
          // Process content parts
          for (const part of msg.content) {
            if (part instanceof LanguageModelTextPart) {
              content += part.value;
            } else if (part instanceof LanguageModelToolCallPart) {
              // Tool calls not yet supported
              content += "[Tool call not supported]";
            } else {
              // For image parts and other unknown parts, just add a note
              // The LM Studio SDK doesn't support multimodal in this simple setup
              content += "[Image content not supported in text format]";
            }
          }
        }

        return {
          role,
          content,
        };
      }),
    );
  }

  // Matches your provided signature exactly
  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation, // The 'T' in your definition
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    const { signal, disposable } = toAbortSignal(token);
    const client = this.client;

    try {
      const loadedModel = await this.getModel(model.id);

      if (!loadedModel) {
        throw new Error(`Failed to load model: ${model.id}`);
      }

      const conversationHistory = await this.convertMessages(messages);

      const prediction = loadedModel.respond(conversationHistory, {
        signal: signal,
      });

      for await (const fragment of prediction) {
        if (token.isCancellationRequested) {
          break;
        }

        if (fragment.content) {
          const part = new LanguageModelTextPart(fragment.content);
          progress.report(part);
        }
      }
    } catch (err) {
      if (token.isCancellationRequested) {
        return;
      }
      console.error("LM Studio Chat Response Error:", err);
      throw err;
    } finally {
      disposable.dispose();
    }
  }

  async provideTokenCount(
    model: LanguageModelChatInformation,
    text: string | LanguageModelChatRequestMessage,
    token: CancellationToken,
  ): Promise<number> {
    if (token.isCancellationRequested) {
      return 0;
    }

    // 2. Normalize Text (Synchronous part)
    let contentToCount = "";
    if (typeof text === "string") {
      contentToCount = text;
    } else {
      // It's a message object
      // If content is string
      if (typeof text.content === "string") {
        contentToCount = text.content;
      }
      // If content is array (Text + Images)
      else {
        for (const part of text.content) {
          if (part instanceof LanguageModelTextPart) {
            contentToCount += part.value;
          }
          // For a synchronous-style heuristic, we just add a flat buffer for images
          // instead of reading the file asynchronously.
          else {
            // Assume ~1000 tokens for any image part (heuristic)
            contentToCount += " ".repeat(4000);
          }
        }
      }
    }

    // 3. Try to use SDK (Async) or Fallback
    try {
      // We must await this because the SDK is network-based
      const loadedModel = await this.getModel(model.id);

      if (loadedModel.countTokens) {
        return await loadedModel.countTokens(contentToCount);
      }
    } catch (e) {
      // Ignore errors and fall back
      // 4. Synchronous Fallback (Character Count)
      // 1 token ~= 4 chars
      return Math.ceil(contentToCount.length / 4);
    }

    return Math.ceil(contentToCount.length / 4);
  }
}
