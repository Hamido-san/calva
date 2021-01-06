import * as vscode from 'vscode';
import { LanguageClient, ServerOptions, LanguageClientOptions } from 'vscode-languageclient';
import * as path from 'path';
import * as state from './state';
import * as util from './utilities'
import { provideClojureDefinition } from './providers/definition';
import * as fs from 'fs';
import { https } from 'follow-redirects';
import * as glob from 'glob';
import config from './config';

let client: LanguageClient;

function createClient(jarPath: string): LanguageClient {
    const serverOptions: ServerOptions = {
        run: { command: 'java', args: ['-jar', jarPath] },
        debug: { command: 'java', args: ['-jar', jarPath] },
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'clojure' }],
        synchronize: {
            configurationSection: 'clojure-lsp',
            fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
        },
        initializationOptions: {
            "dependency-scheme": "jar",
            // LSP-TODO: Use lsp's feature and remove Calva's feature for this 
            "auto-add-ns-to-new-files?": false,
            "document-formatting?": false,
            "document-range-formatting?": false,
            "keep-require-at-start?": true,
            //"use-metadata-for-privacy?": false
        },
        middleware: {
            provideCodeActions(document, range, context, token, next) {
                // Disable code actions
                //return [];
                return next(document, range, context, token);
            },
            provideCodeLenses: async (document, token, next): Promise<vscode.CodeLens[]> => {
                if (state.config().referencesCodeLensEnabled) {
                    return await next(document, token);
                }
                return [];
            },
            resolveCodeLens: async (codeLens, token, next) => {
                if (state.config().referencesCodeLensEnabled) {
                    return await next(codeLens, token);
                }
                return null;
            },
            handleDiagnostics(uri, diagnostics, next) {
                // Disable diagnostics from clojure-lsp
                return;
            },
            provideHover(document, position, token, next) {
                if (util.getConnectedState()) {
                    return null;
                } else {
                    return next(document, position, token);
                }
            },
            async provideDefinition(document, position, token, next) {
                const nReplDefinition = await provideClojureDefinition(document, position, token);
                if (nReplDefinition) {
                    return null;
                } else {
                    return next(document, position, token);
                }
            },
            provideCompletionItem(document, position, context, token, next) {
                if (util.getConnectedState()) {
                    return null;
                } else {
                    return next(document, position, context, token);
                }
            },
            provideSignatureHelp(document, position, context, token, next) {
                if (util.getConnectedState()) {
                    return null;
                } else {
                    return next(document, position, context, token);
                }
            }
        }
    };
    return new LanguageClient(
        'clojure',
        'Clojure Language Client',
        serverOptions,
        clientOptions
    );
}

type ClojureLspCommand = {
    command: string,
    extraParamFn?: () => Thenable<string>,
    category?: string;
}

function makePromptForInput(placeHolder: string) {
    return async () => {
        return await vscode.window.showInputBox({
            value: '',
            placeHolder: placeHolder,
            validateInput: (input => input.trim() === '' ? 'Empty input' : null)
        })
    }
}

const clojureLspCommands: ClojureLspCommand[] = [
    {
        command: 'clean-ns'
    },
    {
        command: 'add-missing-libspec'
    },
    // This seems to be similar to Calva's rewrap commands
    //{
    //    command: 'cycle-coll'
    //},
    {
        command: 'cycle-privacy'
    },
    {
        command: 'expand-let'
    },
    {
        command: 'thread-first'
    },
    {
        command: 'thread-first-all'
    },
    {
        command: 'thread-last'
    },
    {
        command: 'thread-last-all'
    },
    {
        command: 'inline-symbol'
    },
    {
        command: 'unwind-all'
    },
    {
        command: 'unwind-thread'
    },
    {
        command: 'introduce-let',
        extraParamFn: makePromptForInput('Bind to')
    },
    {
        command: 'move-to-let',
        extraParamFn: makePromptForInput('Bind to')
    },
    {
        command: 'extract-function',
        extraParamFn: makePromptForInput('Function name')
    },
    {
        command: 'server-info',
        category: 'calva.diagnostics'
    }
]

function registerLspCommand(client: LanguageClient, command: ClojureLspCommand): vscode.Disposable {
    const category = command.category ? command.category : 'calva.refactor';
    const vscodeCommand = `${category}.${command.command.replace(/-[a-z]/g, (m) => m.substring(1).toUpperCase())}`;
    return vscode.commands.registerCommand(vscodeCommand, async () => {
        const editor = vscode.window.activeTextEditor;
        const document = util.getDocument(editor.document);
        if (document && document.languageId === 'clojure') {
            const line = editor.selection.active.line;
            const column = editor.selection.active.character;
            const docUri = `${document.uri.scheme}://${document.uri.path}`;
            const params = [docUri, line, column];
            const extraParam = command.extraParamFn ? await command.extraParamFn() : undefined;
            if (!command.extraParamFn || command.extraParamFn && extraParam) {
                client.sendRequest('workspace/executeCommand', {
                    'command': command.command,
                    'arguments': extraParam ? [...params, extraParam] : params
                }).catch(e => {
                    console.error(e);
                });
            }
        }
    });
}

function getJarFilePath(baseFilePath: string, version: string): string {
    return path.join(baseFilePath, `clojure-lsp.jar_${version}.jar`);
}

function downloadLspJar(version: string, jarFilePath: string): Promise<void> {
    return new Promise((resolveDownload, rejectDownload) => {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Downloading clojure-lsp",
            cancellable: false
        }, async (progress, _token) => {
            const urlPath = `/clojure-lsp/clojure-lsp/releases/download/${version}/clojure-lsp.jar`;
            return new Promise<void>((resolveProgress, rejectProgress) => {
                https.get({
                    hostname: 'github.com',
                    path: urlPath
                }, (response) => {
                    const jarFileWriteStream = fs.createWriteStream(jarFilePath);
                    const totalBytes = parseInt(response.headers['content-length']);
                    let bytesReceived = 0;
                    let increment = 0;
                    response.on('data', data => {
                        bytesReceived += data.length;
                        increment = (bytesReceived / totalBytes) * 100;
                        progress.report({
                            increment,
                            message: Math.round(increment) + '%'
                        });
                    }).on('end', () => {
                        jarFileWriteStream.close();
                        console.log('clojure-lsp downloaded to ' + jarFilePath);
                        resolveProgress();
                        resolveDownload();
                    }).pipe(jarFileWriteStream);
                });
            });
        });
    });
}

function setupLspFeatures(context: vscode.ExtensionContext): void {
    // The title of this command is dictated by clojure-lsp and is executed when the user clicks the references code lens above a symbol
    context.subscriptions.push(vscode.commands.registerCommand('code-lens-references', async (_, line, character) => {
        vscode.window.activeTextEditor.selection = new vscode.Selection(line - 1, character - 1, line - 1, character - 1);
        await vscode.commands.executeCommand('editor.action.referenceSearch.trigger');
    }));

    context.subscriptions.push(
        ...clojureLspCommands.map(command => registerLspCommand(client, command))
    );

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
        if (event.affectsConfiguration('calva.referencesCodeLens.enabled')) {
            const visibleFileEditors = vscode.window.visibleTextEditors.filter(editor => {
                return editor.document.uri.scheme === 'file';
            });

            for (let editor of visibleFileEditors) {
                // Hacky solution for triggering codeLens refresh
                // Could not find a better way, aside from possibly changes to clojure-lsp
                // https://github.com/microsoft/vscode-languageserver-node/issues/705
                const edit1 = new vscode.WorkspaceEdit();
                edit1.insert(editor.document.uri, new vscode.Position(0, 0), '\n');
                await vscode.workspace.applyEdit(edit1);
                const edit2 = new vscode.WorkspaceEdit();
                edit2.delete(editor.document.uri, new vscode.Range(0, 0, 1, 0));
                await vscode.workspace.applyEdit(edit2);
            }
        }
    }));
}

function deleteJarFiles(globPattern: string, exceptPath: string): void {
    glob(globPattern, (_error, filePaths) => {
        filePaths.forEach(filePath => {
            if (filePath !== exceptPath) {
                fs.unlink(filePath, err => {
                    if (err) {
                        console.error('Error deleting unused clojure-lsp jar', err);
                    }
                });
            }
        });
    });
}

async function activate(context: vscode.ExtensionContext): Promise<void> {
    const version = config.CLOJURE_LSP_VERSION;
    let jarFilePath = getJarFilePath(context.extensionPath, version);

    if (!fs.existsSync(jarFilePath)) {
        const globPattern = jarFilePath.replace(version, '*');
        // We download first, and once we know it succeeded, we delete the old jar file(s)
        await downloadLspJar(version, jarFilePath);
        deleteJarFiles(globPattern, jarFilePath);
    }

    client = createClient(jarFilePath);

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Starting clojure-lsp. You don't need to wait for it to start using Calva. Please go ahead with Jack-in or Connect to the REPL. See [here](https://calva.io/clojure-lsp) for more info.",
        cancellable: false
    }, async (_progress, _token) => {
        await client.onReady();
        setupLspFeatures(context);
    });
    context.subscriptions.push(client.start());
}

async function deactivate() {
    if (client) {
        await client.stop();
    }
}

export default {
    activate,
    deactivate
}