// *****************************************************************************
// Copyright (C) 2018 Red Hat, Inc. and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// some code was copied and modified from https://github.com/Microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadWorkspace.ts
import * as theia from '@theia/plugin';
import { interfaces, injectable } from '@theia/core/shared/inversify';
import { WorkspaceExt, StorageExt, MAIN_RPC_CONTEXT, WorkspaceMain, WorkspaceFolderPickOptionsMain, FindFilesOptions } from '../../common/plugin-api-rpc';
import { RPCProtocol } from '../../common/rpc-protocol';
import { URI as Uri } from '@theia/core/shared/vscode-uri';
import { UriComponents } from '../../common/uri-components';
import { FileSearchService } from '@theia/file-search/lib/common/file-search-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService, WorkspaceTrustService, CanonicalUriService } from '@theia/workspace/lib/browser';
import { Resource } from '@theia/core/lib/common/resource';
import { Disposable, DisposableCollection } from '@theia/core/lib/common/disposable';
import { Emitter, Event, ResourceResolver, CancellationToken, isUndefined } from '@theia/core';
import { PluginServer } from '../../common/plugin-protocol';
import { FileSystemPreferences } from '@theia/filesystem/lib/browser';
import { SearchInWorkspaceService } from '@theia/search-in-workspace/lib/browser/search-in-workspace-service';
import { FileStat } from '@theia/filesystem/lib/common/files';
import { MonacoQuickInputService } from '@theia/monaco/lib/browser/monaco-quick-input-service';
import { RequestService } from '@theia/core/shared/@theia/request';
import { UTF16be, UTF16le, UTF8, UTF8_with_bom } from '@theia/core/lib/common/encodings';
import { EncodingRegistry } from '@theia/core/lib/browser/encoding-registry';
import { PreferenceService } from '@theia/core/lib/browser/preferences/preference-service';

export class WorkspaceMainImpl implements WorkspaceMain, Disposable {

    private readonly proxy: WorkspaceExt;

    private storageProxy: StorageExt;

    private monacoQuickInputService: MonacoQuickInputService;

    private fileSearchService: FileSearchService;

    private searchInWorkspaceService: SearchInWorkspaceService;

    private roots: string[];

    private resourceResolver: TextContentResourceResolver;

    private pluginServer: PluginServer;

    private requestService: RequestService;

    private workspaceService: WorkspaceService;

    protected readonly canonicalUriService: CanonicalUriService;

    private workspaceTrustService: WorkspaceTrustService;

    private encodingRegistry: EncodingRegistry;

    private fsPreferences: FileSystemPreferences;

    private preferenceService: PreferenceService;

    protected readonly toDispose = new DisposableCollection();

    protected workspaceSearch: Set<number> = new Set<number>();

    protected readonly canonicalUriProviders = new Map<string, Disposable>();

    constructor(rpc: RPCProtocol, container: interfaces.Container) {
        this.proxy = rpc.getProxy(MAIN_RPC_CONTEXT.WORKSPACE_EXT);
        this.storageProxy = rpc.getProxy(MAIN_RPC_CONTEXT.STORAGE_EXT);
        this.monacoQuickInputService = container.get(MonacoQuickInputService);
        this.fileSearchService = container.get(FileSearchService);
        this.searchInWorkspaceService = container.get(SearchInWorkspaceService);
        this.resourceResolver = container.get(TextContentResourceResolver);
        this.pluginServer = container.get(PluginServer);
        this.requestService = container.get(RequestService);
        this.workspaceService = container.get(WorkspaceService);
        this.canonicalUriService = container.get(CanonicalUriService);
        this.workspaceTrustService = container.get(WorkspaceTrustService);
        this.encodingRegistry = container.get(EncodingRegistry);
        this.fsPreferences = container.get(FileSystemPreferences);
        this.preferenceService = container.get(PreferenceService);

        this.processWorkspaceFoldersChanged(this.workspaceService.tryGetRoots().map(root => root.resource.toString()));
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(roots => {
            this.processWorkspaceFoldersChanged(roots.map(root => root.resource.toString()));
        }));
        this.toDispose.push(this.workspaceService.onWorkspaceLocationChanged(stat => {
            this.proxy.$onWorkspaceLocationChanged(stat);
        }));

        this.workspaceTrustService.getWorkspaceTrust().then(trust => this.proxy.$onWorkspaceTrustChanged(trust));
    }

    dispose(): void {
        this.toDispose.dispose();
    }

    $resolveProxy(url: string): Promise<string | undefined> {
        return this.requestService.resolveProxy(url);
    }

    protected async processWorkspaceFoldersChanged(roots: string[]): Promise<void> {
        if (this.isAnyRootChanged(roots) === false) {
            return;
        }
        this.roots = roots;
        this.proxy.$onWorkspaceFoldersChanged({ roots });

        const keyValueStorageWorkspacesData = await this.pluginServer.getAllStorageValues({
            workspace: this.workspaceService.workspace?.resource.toString(),
            roots: this.workspaceService.tryGetRoots().map(root => root.resource.toString())
        });
        this.storageProxy.$updatePluginsWorkspaceData(keyValueStorageWorkspacesData);

    }

    private isAnyRootChanged(roots: string[]): boolean {
        if (!this.roots || this.roots.length !== roots.length) {
            return true;
        }

        return this.roots.some((root, index) => root !== roots[index]);
    }

    async $getWorkspace(): Promise<FileStat | undefined> {
        return this.workspaceService.workspace;
    }

    $pickWorkspaceFolder(options: WorkspaceFolderPickOptionsMain): Promise<theia.WorkspaceFolder | undefined> {
        return new Promise((resolve, reject) => {
            // Return undefined if workspace root is not set
            if (!this.roots || !this.roots.length) {
                resolve(undefined);
                return;
            }

            // Active before appearing the pick menu
            const activeElement: HTMLElement | undefined = window.document.activeElement as HTMLElement;

            // WorkspaceFolder to be returned
            let returnValue: theia.WorkspaceFolder | undefined;

            const items = this.roots.map(root => {
                const rootUri = Uri.parse(root);
                const rootPathName = rootUri.path.substring(rootUri.path.lastIndexOf('/') + 1);
                return {
                    label: rootPathName,
                    detail: rootUri.path,
                    execute: () => {
                        returnValue = {
                            uri: rootUri,
                            name: rootPathName,
                            index: 0
                        } as theia.WorkspaceFolder;
                    }
                };
            });

            // Show pick menu
            this.monacoQuickInputService.showQuickPick(items, {
                onDidHide: () => {
                    if (activeElement) {
                        activeElement.focus({ preventScroll: true });
                    }
                    resolve(returnValue);
                }
            });
        });
    }

    async $startFileSearch(includePattern: string, includeFolderUri: string | undefined, options: FindFilesOptions): Promise<UriComponents[]> {
        const roots: FileSearchService.RootOptions = {};
        const rootUris = includeFolderUri ? [includeFolderUri] : this.roots;
        for (const rootUri of rootUris) {
            roots[rootUri] = {};
        }
        const opts: FileSearchService.Options = {
            rootOptions: roots,
            fuzzyMatch: options.fuzzy,
            useGitIgnore: options.useIgnoreFiles
        };
        if (includePattern) {
            opts.includePatterns = [includePattern];
        }
        if (options.exclude) {
            opts.excludePatterns = [options.exclude];
        }
        if (options.useDefaultExcludes) {
            for (const rootUri of rootUris) {
                const filesExclude = this.fsPreferences.get('files.exclude', undefined, rootUri);
                if (filesExclude) {
                    for (const excludePattern in filesExclude) {
                        if (filesExclude[excludePattern]) {
                            const rootOptions = roots[rootUri];
                            const rootExcludePatterns = rootOptions.excludePatterns || [];
                            rootExcludePatterns.push(excludePattern);
                            rootOptions.excludePatterns = rootExcludePatterns;
                        }
                    }
                }
            }
        }
        if (typeof options.maxResults === 'number') {
            opts.limit = options.maxResults;
        }
        const uriStrs = await this.fileSearchService.find('', opts);
        return uriStrs.map(uriStr => Uri.parse(uriStr));
    }

    async $findTextInFiles(query: theia.TextSearchQuery, options: theia.FindTextInFilesOptions, searchRequestId: number,
        token: theia.CancellationToken = CancellationToken.None): Promise<theia.TextSearchComplete> {
        const maxHits = options.maxResults ? options.maxResults : 150;
        const excludes = options.exclude ? (typeof options.exclude === 'string' ? options.exclude : (<theia.RelativePattern>options.exclude).pattern) : undefined;
        const includes = options.include ? (typeof options.include === 'string' ? options.include : (<theia.RelativePattern>options.include).pattern) : undefined;
        let canceledRequest = false;
        return new Promise(resolve => {
            let matches = 0;
            const what: string = query.pattern;
            this.searchInWorkspaceService.searchWithCallback(what, this.roots, {
                onResult: (searchId, result) => {
                    if (canceledRequest) {
                        return;
                    }
                    const hasSearch = this.workspaceSearch.has(searchId);
                    if (!hasSearch) {
                        this.workspaceSearch.add(searchId);
                        token.onCancellationRequested(() => {
                            this.searchInWorkspaceService.cancel(searchId);
                            canceledRequest = true;
                        });
                    }
                    if (token.isCancellationRequested) {
                        this.searchInWorkspaceService.cancel(searchId);
                        canceledRequest = true;
                        return;
                    }
                    if (result && result.matches && result.matches.length) {
                        while ((matches + result.matches.length) > maxHits) {
                            result.matches.splice(result.matches.length - 1, 1);
                        }
                        this.proxy.$onTextSearchResult(searchRequestId, false, result);
                        matches += result.matches.length;
                        if (maxHits <= matches) {
                            this.searchInWorkspaceService.cancel(searchId);
                        }
                    }
                },
                onDone: (searchId, _error) => {
                    const hasSearch = this.workspaceSearch.has(searchId);
                    if (hasSearch) {
                        this.searchInWorkspaceService.cancel(searchId);
                        this.workspaceSearch.delete(searchId);
                    }
                    this.proxy.$onTextSearchResult(searchRequestId, true);
                    if (maxHits <= matches) {
                        resolve({ limitHit: true });
                    } else {
                        resolve({ limitHit: false });
                    }
                }
            }, {
                useRegExp: query.isRegExp,
                matchCase: query.isCaseSensitive,
                matchWholeWord: query.isWordMatch,
                exclude: excludes ? [excludes] : undefined,
                include: includes ? [includes] : undefined,
                maxResults: maxHits
            });
        });
    }

    async $registerTextDocumentContentProvider(scheme: string): Promise<void> {
        this.resourceResolver.registerContentProvider(scheme, this.proxy);
        this.toDispose.push(Disposable.create(() => this.resourceResolver.unregisterContentProvider(scheme)));
    }

    $unregisterTextDocumentContentProvider(scheme: string): void {
        this.resourceResolver.unregisterContentProvider(scheme);
    }

    $onTextDocumentContentChange(uri: string, content: string): void {
        this.resourceResolver.onContentChange(uri, content);
    }

    async $updateWorkspaceFolders(start: number, deleteCount?: number, ...rootsToAdd: string[]): Promise<void> {
        await this.workspaceService.spliceRoots(start, deleteCount, ...rootsToAdd.map(root => new URI(root)));
    }

    async $requestWorkspaceTrust(_options?: theia.WorkspaceTrustRequestOptions): Promise<boolean | undefined> {
        return this.workspaceTrustService.requestWorkspaceTrust();
    }

    async $registerCanonicalUriProvider(scheme: string): Promise<void | undefined> {
        this.canonicalUriProviders.set(scheme,
            this.canonicalUriService.registerCanonicalUriProvider(scheme, {
                provideCanonicalUri: async (uri, targetScheme, token) => {
                    const canonicalUri = await this.proxy.$provideCanonicalUri(uri.toString(), targetScheme, CancellationToken.None);
                    return isUndefined(uri) ? undefined : new URI(canonicalUri);
                },
                dispose: () => {
                    this.proxy.$disposeCanonicalUriProvider(scheme);
                },
            }));
    }

    $unregisterCanonicalUriProvider(scheme: string): void {
        const disposable = this.canonicalUriProviders.get(scheme);
        if (disposable) {
            this.canonicalUriProviders.delete(scheme);
            disposable.dispose();
        } else {
            console.warn(`No canonical uri provider registered for '${scheme}'`);
        }
    }

    async $getCanonicalUri(uri: string, targetScheme: string, token: theia.CancellationToken): Promise<string | undefined> {
        const canonicalUri = await this.canonicalUriService.provideCanonicalUri(new URI(uri), targetScheme, token);
        return isUndefined(canonicalUri) ? undefined : canonicalUri.toString();
    }

    async $resolveDecoding(resource: UriComponents | undefined, options?: { encoding?: string }): Promise<{ preferredEncoding: string; guessEncoding: boolean }> {
        const preferredEncoding = await this.getPreferredReadEncoding(resource, options);

        return {
            preferredEncoding,
            guessEncoding: this.preferenceService.get('files.autoGuessEncoding', false, resource ? resource.toString() : undefined)
        };
    }

    async $resolveEncoding(resource: UriComponents | undefined, options?: { encoding?: string }): Promise<{ encoding: string; hasBOM: boolean }> {
        let encoding: string;
        if (resource) {
            encoding = await this.encodingRegistry.getEncodingForResource(URI.fromComponents(resource), options?.encoding);
        } else {
            encoding = options?.encoding ?? UTF8;
        }
        // see https://github.com/microsoft/vscode/blob/118f9ecd71a8f101b71ae19e3bf44802aa173209/src/vs/workbench/services/textfile/browser/textFileService.ts#L806
        const hasBOM = encoding === UTF16be || encoding === UTF16le || encoding === UTF8_with_bom;

        return { encoding, hasBOM };
    }

    async $getValidEncoding(uri: UriComponents | undefined, detectedEncoding: string | undefined, options: { encoding: string } | undefined): Promise<string> {
        return this.getPreferredReadEncoding(uri, options, detectedEncoding);
    }

    async getPreferredReadEncoding(uri: UriComponents | undefined, options?: { encoding?: string }, detectedEncoding?: string): Promise<string> {
        let preferredEncoding: string | undefined;

        // either encoding is passed as an option
        // or we have a detected encoding,
        // or we are looking in the preferences
        // or we default at UTF8
        if (options?.encoding) {
            if (detectedEncoding === UTF8_with_bom && options.encoding === UTF8) {
                preferredEncoding = UTF8_with_bom; // indicate the file has BOM if we are to resolve with UTF 8
            } else {
                preferredEncoding = options.encoding; // give passed in encoding highest priority
            }
        } else if (typeof detectedEncoding === 'string') {
            preferredEncoding = detectedEncoding;
        }
        let encoding;
        if (uri) {
            encoding = await this.encodingRegistry.getEncodingForResource(URI.fromComponents(uri), preferredEncoding);
        } else {
            encoding = preferredEncoding ?? UTF8;
        }

        return encoding;
    }
}

/**
 * Text content provider for resources with custom scheme.
 */
export interface TextContentResourceProvider {

    /**
     * Provides resource for given URI
     */
    provideResource(uri: URI): Resource;

}

@injectable()
export class TextContentResourceResolver implements ResourceResolver {

    // Resource providers for different schemes
    private providers = new Map<string, TextContentResourceProvider>();

    // Opened resources
    private resources = new Map<string, TextContentResource>();

    async resolve(uri: URI): Promise<Resource> {
        const provider = this.providers.get(uri.scheme);
        if (provider) {
            return provider.provideResource(uri);
        }

        throw new Error(`Unable to find Text Content Resource Provider for scheme '${uri.scheme}'`);
    }

    registerContentProvider(scheme: string, proxy: WorkspaceExt): void {
        if (this.providers.has(scheme)) {
            throw new Error(`Text Content Resource Provider for scheme '${scheme}' is already registered`);
        }

        const instance = this;
        this.providers.set(scheme, {
            provideResource: (uri: URI): Resource => {
                let resource = instance.resources.get(uri.toString());
                if (resource) {
                    return resource;
                }

                resource = new TextContentResource(uri, proxy, {
                    dispose(): void {
                        instance.resources.delete(uri.toString());
                    }
                });

                instance.resources.set(uri.toString(), resource);
                return resource;
            }
        });
    }

    unregisterContentProvider(scheme: string): void {
        if (!this.providers.delete(scheme)) {
            throw new Error(`Text Content Resource Provider for scheme '${scheme}' has not been registered`);
        }
    }

    onContentChange(uri: string, content: string): void {
        const resource = this.resources.get(uri);
        if (resource) {
            resource.setContent(content);
        }
    }

}

export class TextContentResource implements Resource {

    private onDidChangeContentsEmitter: Emitter<void> = new Emitter<void>();
    readonly onDidChangeContents: Event<void> = this.onDidChangeContentsEmitter.event;

    // cached content
    cache: string | undefined;

    constructor(public uri: URI, private proxy: WorkspaceExt, protected disposable: Disposable) {
    }

    async readContents(options?: { encoding?: string }): Promise<string> {
        if (this.cache) {
            const content = this.cache;
            this.cache = undefined;
            return content;
        } else {
            const content = await this.proxy.$provideTextDocumentContent(this.uri.toString());
            return content ?? '';
        }
    }

    dispose(): void {
        this.disposable.dispose();
    }

    setContent(content: string): void {
        this.cache = content;
        this.onDidChangeContentsEmitter.fire(undefined);
    }

}
