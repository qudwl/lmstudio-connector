// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { LMSConnectorProvider } from "./Provider";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  console.log("LM Studio Connector activating...");

  try {
    const provider = new LMSConnectorProvider();
    console.log("LM Studio Connector provider created");

    const disposable = vscode.lm.registerLanguageModelChatProvider(
      "lmstudio",
      provider,
    );
    context.subscriptions.push(disposable);

    console.log("LM Studio Connector successfully registered as chat provider");
  } catch (err) {
    console.error("LM Studio Connector activation failed:", err);
    vscode.window.showErrorMessage(
      `LM Studio Connector activation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// This method is called when your extension is deactivated
export function deactivate() {
  console.log("LM Studio Connector deactivating...");
}
