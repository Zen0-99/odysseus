import * as vscode from 'vscode';
import { ChatPanelProvider } from './chatPanel';
import { OdysseusClient } from './odysseusClient';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatPanelProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('odysseus.chat', () => {
      vscode.commands.executeCommand('odysseus.chatPanel.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('odysseus.connect', async () => {
      const client = new OdysseusClient();
      const health = await client.health();
      if (health.ok) {
        vscode.window.showInformationMessage(`Odysseus connected! Version: ${health.version || 'unknown'}`);
        vscode.commands.executeCommand('setContext', 'odysseus.connected', true);
      } else {
        vscode.window.showErrorMessage('Cannot reach Odysseus. Check host and token in settings.');
      }
    })
  );
}

export function deactivate(): void {}
