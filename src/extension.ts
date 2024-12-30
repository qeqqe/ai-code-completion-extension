import * as vscode from "vscode";
import axios, { CancelTokenSource } from "axios";

const LOCALHOST_URL = "http://localhost:1234/v1";
const DEBOUNCE_DELAY = 300;

interface CompletionRequest {
  messages: {
    role: "system" | "user";
    content: string;
  }[];
  model: string;
  temperature: number;
  max_tokens: number;
  stream: boolean;
}

const SYSTEM_PROMPT = `You are an expert TypeScript/JavaScript code completion AI. Your responses must ONLY contain pure code - no explanations, comments, or markdown.

Context Understanding:
- Parse and understand full project structure, dependencies, and patterns
- Analyze current file's imports, types, and component hierarchy
- Consider parent components, hooks usage, and state management
- Detect coding style, naming conventions, and architecture patterns

Code Generation Rules:
1. Output only valid, compilable TypeScript/JavaScript
2. Match project's type safety level and patterns
3. Complete full logical blocks (if started)
4. Follow established naming patterns
5. Use imported types/components correctly
6. Maintain consistent error handling
7. Complete proper React/Next.js/Nest.js patterns
8. Keep consistent state management approach
9. Use correct hook patterns and lifecycle
10. Follow existing project architecture

Framework-Specific Rules:
React/Next.js:
- Correct hooks order and dependencies
- Proper prop types and validation
- Consistent component patterns
- Proper data fetching patterns
- Efficient state updates
- Correct routing patterns

Database/API:
- Type-safe query building
- Proper error handling
- Consistent response formats
- Security best practices
- Proper transaction handling

Current Focus: Complete only the immediate code need, no explanations`;

class CompletionProvider implements vscode.InlineCompletionItemProvider {
  private outputChannel: vscode.OutputChannel;
  private lastRequest: CancelTokenSource | null = null;
  private debounceTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel(
      "LM Studio Completions"
    );
  }

  private debounce<T extends (...args: any[]) => Promise<any>>(
    fn: T,
    delay: number
  ): (...args: Parameters<T>) => Promise<ReturnType<T>> {
    return (...args: Parameters<T>) => {
      if (this.debounceTimeout) {
        clearTimeout(this.debounceTimeout);
      }
      if (this.lastRequest) {
        this.lastRequest.cancel("New request initiated");
      }

      return new Promise((resolve) => {
        this.debounceTimeout = setTimeout(() => {
          resolve(fn.apply(this, args));
        }, delay);
      });
    };
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    const debouncedCompletion = this.debounce(async () => {
      const currentLine = document.lineAt(position.line).text;
      const precedingText = document.getText(
        new vscode.Range(
          new vscode.Position(Math.max(0, position.line - 10), 0),
          position
        )
      );

      if (!currentLine.trim() || currentLine.trim().length < 2) {
        return [];
      }

      const imports =
        document
          .getText()
          .match(/import.*from.*;/g)
          ?.join("\n") || "";
      const currentScope = document.getText(
        new vscode.Range(
          new vscode.Position(Math.max(0, position.line - 20), 0),
          position
        )
      );

      try {
        this.lastRequest = axios.CancelToken.source();

        const response = await axios.post(
          `${LOCALHOST_URL}/chat/completions`,
          {
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: `Previous context:\n${precedingText}\nScope: ${currentScope}\nImports: ${imports}\nComplete this code:`,
              },
            ],
            model: "codellama-7b-instruct",
            temperature: 0.1,
            max_tokens: 150,
            stream: false,
          },
          {
            timeout: 10000,
            cancelToken: this.lastRequest.token,
            headers: { "Content-Type": "application/json" },
          }
        );

        const completion = response.data.choices[0]?.message?.content?.trim();

        if (!completion) {
          return [];
        }

        if (completion === currentLine) {
          return [];
        }

        const range = new vscode.Range(
          position.translate(0, -currentLine.length),
          position
        );

        return [new vscode.InlineCompletionItem(completion, range)];
      } catch (error) {
        if (axios.isCancel(error)) {
          return [];
        }
        this.outputChannel.appendLine(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }
    }, DEBOUNCE_DELAY)();

    return debouncedCompletion;
  }
}

export async function activate(context: vscode.ExtensionContext) {
  try {
    await axios.get(`${LOCALHOST_URL}/models`);

    const provider = new CompletionProvider();
    const disposable = vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      provider
    );

    context.subscriptions.push(disposable);

    vscode.window.showInformationMessage(
      "LM Studio Completions activated! Start typing to see suggestions."
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      "Failed to connect to LM Studio. Make sure it's running on port 1234."
    );
  }
}

export function deactivate() {}
