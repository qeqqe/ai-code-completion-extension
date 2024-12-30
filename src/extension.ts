import * as vscode from "vscode";
import axios, { CancelTokenSource } from "axios";

const LOCALHOST_URL = "http://localhost:1234/v1";
const DEBOUNCE_DELAY = 300;

const BASE_PROMPTS = {
  typescript: `You are a TypeScript code completion AI. Generate TypeScript code with:
- Proper type annotations
- Interface definitions when needed
- Type-safe operations
- Modern TypeScript patterns`,
  javascript: `You are a JavaScript code completion AI. Generate JavaScript code with:
- ES6+ modern syntax
- No TypeScript types
- JavaScript-specific patterns
- Runtime-friendly code`,
  // will add more
} as const;

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
  private currentLanguage: string = "javascript";

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

  private cleanCompletion(completion: string): string {
    let cleaned = completion
      .replace(/```(?:typescript|javascript)?\n?/g, "")
      .replace(/```\n?/g, "")
      .replace(/^\n+/, "")
      .replace(/\n+$/, "")
      .replace(/^\s*\/\/.*$/gm, "");

    if (cleaned.includes("function") && cleaned.includes("{")) {
      const functionMatch = cleaned.match(/^[^{]*{[^}]*}$/);
      if (functionMatch) {
        cleaned = functionMatch[0];
      }
    }

    if (cleaned.includes("console.log(")) {
      const stringMatch = cleaned.match(/console\.log\((["'])(.*?)\1\)/);
      if (stringMatch) {
        return `console.log("${stringMatch[2]}")`;
      }
    }

    if (this.currentLanguage === "javascript") {
      cleaned = cleaned
        .replace(/: \w+(?=[\s,)])/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/: \w+\[\]/g, "")
        .replace(/interface \w+ {[^}]+}/g, "");
    }

    return cleaned;
  }

  private getContextFromComments(
    document: vscode.TextDocument,
    position: vscode.Position
  ): string {
    let lineNumber = position.line;
    let context = "";

    while (lineNumber >= 0 && lineNumber > position.line - 5) {
      const line = document.lineAt(lineNumber).text.trim();
      if (line.startsWith("//")) {
        context = line + "\n" + context;
      } else if (context) {
        break;
      }
      lineNumber--;
    }

    return context;
  }

  private getLanguageContext(document: vscode.TextDocument): {
    language: string;
    basePrompt: string;
  } {
    const languageId = document.languageId;
    const fileExtension =
      document.uri.fsPath.split(".").pop()?.toLowerCase() || "";

    let language = "javascript";
    if (
      languageId === "typescript" ||
      fileExtension === "ts" ||
      fileExtension === "tsx"
    ) {
      language = "typescript";
    }

    this.currentLanguage = language;

    return {
      language,
      basePrompt:
        BASE_PROMPTS[language as keyof typeof BASE_PROMPTS] ||
        BASE_PROMPTS.javascript,
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
      const currentLineUptoCursor = currentLine.substring(
        0,
        position.character
      );

      const commentContext = this.getContextFromComments(document, position);
      const isEmptyLine = !currentLine.trim();

      if (
        !commentContext &&
        !isEmptyLine &&
        currentLineUptoCursor.trim().length < 2
      ) {
        return [];
      }

      const openBrackets = (currentLineUptoCursor.match(/{/g) || []).length;
      const closeBrackets = (currentLineUptoCursor.match(/}/g) || []).length;
      const isInsideFunction = openBrackets > closeBrackets;

      const { language, basePrompt } = this.getLanguageContext(document);

      try {
        this.lastRequest = axios.CancelToken.source();

        const systemPrompt = `${basePrompt}

Code Generation Rules:
1. Output only valid, compilable ${language} code
2. Follow established ${language} naming patterns
3. Complete full logical blocks (if started)
4. Match existing code style
5. No comments or explanations in output
6. No markdown formatting

Current file type: ${language}
Current file extension: ${document.uri.fsPath.split(".").pop()}
IMPORTANT: For console.log statements, only complete the string content. Do not nest functions.`;

        const response = await axios.post(
          `${LOCALHOST_URL}/chat/completions`,
          {
            messages: [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: `File type: ${language}
Context:
${commentContext}
Current line:
${currentLineUptoCursor}
Complete this code:`,
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

        let completion = response.data.choices[0]?.message?.content;

        if (!completion) {
          return [];
        }

        completion = this.cleanCompletion(completion)
          .replace(/\r\n/g, "\n")
          .replace(/^\s+/g, "");

        if (currentLineUptoCursor.includes("console.log(")) {
          if (!completion.endsWith(")")) {
            completion += '")';
          }
          if (!completion.includes('"') && !completion.includes("'")) {
            completion = `"${completion}`;
          }
        }

        if (isEmptyLine && commentContext) {
          return [
            new vscode.InlineCompletionItem(
              completion,
              new vscode.Range(position, position)
            ),
          ];
        }

        this.outputChannel.appendLine(
          `Current line: "${currentLineUptoCursor}"`
        );
        this.outputChannel.appendLine(`Completion: "${completion}"`);

        if (completion === currentLineUptoCursor || !completion.trim()) {
          return [];
        }

        if (!completion.startsWith(currentLineUptoCursor.trimLeft())) {
          completion = currentLineUptoCursor + completion;
        }

        this.outputChannel.appendLine(`Comment context: "${commentContext}"`);
        this.outputChannel.appendLine(
          `Current line: "${currentLineUptoCursor}"`
        );
        this.outputChannel.appendLine(`Completion: "${completion}"`);

        return [
          new vscode.InlineCompletionItem(
            completion,
            new vscode.Range(new vscode.Position(position.line, 0), position)
          ),
        ];
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
