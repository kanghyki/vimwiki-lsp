const {
    createConnection,
    TextDocuments,
    CompletionItemKind,
    TextDocumentSyncKind,
    MarkupKind,
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");
const fs = require("fs");
const path = require("path");

// 로거 유틸리티
const logger = {
    logFile: "/tmp/wiki-lsp.log",
    log(...args) {
        try {
            const msg = `[${new Date().toISOString()}] ${args
                .map(String)
                .join(" ")}\n`;
            fs.appendFileSync(this.logFile, msg);
        } catch (error) {
            // 로그 실패 시 무시 (무한 루프 방지)
        }
    },
};

// 설정 상수
const CONFIG = {
    SCAN_INTERVAL: 5000,
    FILE_EXTENSION: ".md",
    MAX_COMPLETION_RESULTS: 50,
    ENCODING: "utf-8",
};

// Frontmatter 파서
class FrontmatterParser {
    static parse(content) {
        if (!content || typeof content !== "string") return null;

        const regex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
        const match = content.match(regex);
        if (!match) return null;

        const frontmatter = {};
        const lines = match[1].split("\n");

        for (const line of lines) {
            const colonIndex = line.indexOf(":");
            if (colonIndex !== -1) {
                const key = line.substring(0, colonIndex).trim();
                const value = line.substring(colonIndex + 1).trim();
                if (key) {
                    frontmatter[key] = value;
                }
            }
        }

        return frontmatter;
    }
}

// 파일 시스템 유틸리티
class FileUtils {
    static exists(filePath) {
        if (!filePath || typeof filePath !== "string") return false;

        try {
            return fs.existsSync(filePath);
        } catch {
            return false;
        }
    }

    static readFile(filePath) {
        if (!filePath || typeof filePath !== "string") return null;

        try {
            return fs.readFileSync(filePath, CONFIG.ENCODING);
        } catch (error) {
            logger.log(`파일 읽기 실패: ${filePath}`, error.message);
            return null;
        }
    }

    static getStats(filePath) {
        if (!filePath || typeof filePath !== "string") return null;

        try {
            return fs.statSync(filePath);
        } catch {
            return null;
        }
    }

    static isMarkdownFile(fileName) {
        return (
            fileName &&
            typeof fileName === "string" &&
            fileName.endsWith(CONFIG.FILE_EXTENSION)
        );
    }

    static removeExtension(fileName) {
        if (!fileName || typeof fileName !== "string") return "";
        return fileName.replace(new RegExp(`\\${CONFIG.FILE_EXTENSION}$`), "");
    }
}

// 경로 유틸리티
class PathUtils {
    static isRelativePath(wikiLink) {
        return (
            wikiLink &&
            (wikiLink.startsWith("../") || wikiLink.startsWith("./"))
        );
    }

    static resolveWikiPath(wikiLink, currentDir, wikiRoot) {
        if (!wikiLink || !currentDir || !wikiRoot) return null;

        try {
            if (this.isRelativePath(wikiLink)) {
                return path.resolve(
                    currentDir,
                    wikiLink + CONFIG.FILE_EXTENSION
                );
            }
            return path.join(wikiRoot, wikiLink + CONFIG.FILE_EXTENSION);
        } catch (error) {
            logger.log(`경로 해결 실패: ${wikiLink}`, error.message);
            return null;
        }
    }

    static getRelativePath(from, to) {
        if (
            !from ||
            !to ||
            typeof from !== "string" ||
            typeof to !== "string"
        ) {
            return "";
        }

        try {
            return path
                .relative(from, to)
                .replace(new RegExp(`\\${CONFIG.FILE_EXTENSION}$`), "")
                .replace(/\\/g, "/");
        } catch {
            return "";
        }
    }

    static getDisplayDirectory(relativePath) {
        if (!relativePath || typeof relativePath !== "string") return "root";

        const dirName = path.dirname(relativePath);
        return dirName === "." ? "root" : dirName;
    }
}

// 위키 링크 파서
class WikiLinkParser {
    static extract(text, position) {
        if (!text || typeof text !== "string" || typeof position !== "number") {
            return null;
        }

        const regex = /\[\[([^\]]+)\]\]/g;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const start = match.index;
            const end = match.index + match[0].length;

            if (position >= start && position <= end) {
                return match[1];
            }
        }

        return null;
    }

    static findCompletionTrigger(line, position) {
        if (!line || typeof line !== "string" || typeof position !== "number") {
            return null;
        }

        const prefix = line.slice(0, position);
        const match = prefix.match(/\[\[([^\]]*)$/);

        return match ? match[1] : null;
    }
}

// 파일 정보 모델
class FileInfo {
    constructor(data = {}) {
        this.title = data.title || "제목 없음";
        this.summary = data.summary || "요약 없음";
        this.date = data.date;
        this.updated = data.updated;
        this.exists = data.exists !== undefined ? data.exists : true;
    }

    static fromFrontmatter(frontmatter, filePath) {
        if (!filePath) return new FileInfo({ exists: false });

        const fileName = path.basename(filePath, CONFIG.FILE_EXTENSION);
        return new FileInfo({
            title: frontmatter?.title || fileName,
            summary: frontmatter?.summary,
            date: frontmatter?.date,
            updated: frontmatter?.updated,
            exists: true,
        });
    }

    static notFound(fileName) {
        return new FileInfo({
            title: fileName || "알 수 없는 파일",
            summary: "파일을 찾을 수 없음",
            exists: false,
        });
    }

    toHoverContent() {
        let content = `**${this.title}**\n\n`;

        if (this.summary && this.summary !== "요약 없음") {
            content += `${this.summary}\n\n`;
        }

        if (this.date) {
            content += `📅 생성일: ${this.date}\n`;
        }

        if (this.updated) {
            content += `🔄 수정일: ${this.updated}\n`;
        }

        return content;
    }

    toCompletionDocumentation() {
        return this.summary && this.summary !== "요약 없음"
            ? `**${this.title}**\n\n${this.summary}`
            : `**${this.title}**`;
    }
}

// 캐시 엔트리 모델
class CacheEntry {
    constructor(data, mtime) {
        this.data = data;
        this.mtime = mtime;
    }

    isValid(currentMtime) {
        return this.mtime === currentMtime;
    }
}

// 메인 파일 캐시 시스템
class FileCache {
    constructor() {
        this.cache = new Map();
        this.fileIndex = new Map();
        this.lastScan = 0;
        this.initialized = false;
    }

    shouldRescan() {
        return Date.now() - this.lastScan > CONFIG.SCAN_INTERVAL;
    }

    // 초기화 시 모든 파일 캐싱
    async initialize(wikiRoot) {
        if (this.initialized || !wikiRoot) return;

        logger.log("파일 캐시 초기화 시작...");
        const startTime = Date.now();

        try {
            this._fullScan(wikiRoot);
            this.initialized = true;

            const duration = Date.now() - startTime;
            logger.log(
                `캐시 초기화 완료. ${this.cache.size}개 파일, ${duration}ms`
            );
        } catch (error) {
            logger.log("캐시 초기화 실패:", error.message);
        }
    }

    _fullScan(wikiRoot) {
        if (!FileUtils.exists(wikiRoot)) {
            logger.log(`위키 루트 디렉터리가 존재하지 않음: ${wikiRoot}`);
            return;
        }

        this.lastScan = Date.now();
        const newIndex = new Map();

        this._walkAndCacheDirectory(wikiRoot, wikiRoot, newIndex);
        this.fileIndex = newIndex;
    }

    // 점진적 스캔 (변경 감지용)
    scanDirectory(wikiRoot) {
        if (!this.shouldRescan() || !wikiRoot) return;

        this.lastScan = Date.now();
        const newIndex = new Map();

        this._walkDirectory(wikiRoot, wikiRoot, newIndex);
        this.fileIndex = newIndex;
    }

    // 디렉터리 순회하면서 모든 파일 캐싱
    _walkAndCacheDirectory(dir, wikiRoot, index) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry || !entry.name) continue;

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    this._walkAndCacheDirectory(fullPath, wikiRoot, index);
                } else if (
                    entry.isFile() &&
                    FileUtils.isMarkdownFile(entry.name)
                ) {
                    this._indexAndCacheFile(fullPath, wikiRoot, index);
                }
            }
        } catch (error) {
            logger.log(`디렉터리 스캔 실패: ${dir}`, error.message);
        }
    }

    // 일반 디렉터리 순회 (캐시 없이)
    _walkDirectory(dir, wikiRoot, index) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry || !entry.name) continue;

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    this._walkDirectory(fullPath, wikiRoot, index);
                } else if (
                    entry.isFile() &&
                    FileUtils.isMarkdownFile(entry.name)
                ) {
                    this._indexFile(fullPath, wikiRoot, index);
                }
            }
        } catch (error) {
            logger.log(`디렉터리 스캔 실패: ${dir}`, error.message);
        }
    }

    // 파일 인덱싱 및 즉시 캐싱
    _indexAndCacheFile(fullPath, wikiRoot, index) {
        try {
            const relativePath = FileUtils.removeExtension(
                path.relative(wikiRoot, fullPath)
            );

            const fileName = path.basename(relativePath);
            if (fileName) {
                index.set(fileName.toLowerCase(), fullPath);
                index.set(relativePath.toLowerCase(), fullPath);
            }

            this._loadAndCacheFile(fullPath);
        } catch (error) {
            logger.log(`파일 인덱싱 실패: ${fullPath}`, error.message);
        }
    }

    _indexFile(fullPath, wikiRoot, index) {
        try {
            const relativePath = FileUtils.removeExtension(
                path.relative(wikiRoot, fullPath)
            );

            const fileName = path.basename(relativePath);
            if (fileName) {
                index.set(fileName.toLowerCase(), fullPath);
                index.set(relativePath.toLowerCase(), fullPath);
            }

            this._invalidateIfModified(fullPath);
        } catch (error) {
            logger.log(`파일 인덱싱 실패: ${fullPath}`, error.message);
        }
    }

    _invalidateIfModified(fullPath) {
        if (!this.cache.has(fullPath)) return;

        const stats = FileUtils.getStats(fullPath);
        if (!stats) {
            this.cache.delete(fullPath);
            return;
        }

        const cached = this.cache.get(fullPath);
        if (!cached.isValid(stats.mtime.getTime())) {
            this.cache.delete(fullPath);
            this._loadAndCacheFile(fullPath);
        }
    }

    getFileInfo(filePath) {
        if (!filePath) {
            return FileInfo.notFound();
        }

        const cached = this.cache.get(filePath);
        if (cached) {
            const stats = FileUtils.getStats(filePath);
            if (stats && cached.isValid(stats.mtime.getTime())) {
                return cached.data;
            }
        }

        return this._loadAndCacheFile(filePath);
    }

    _loadAndCacheFile(filePath, stats = null) {
        if (!stats) {
            stats = FileUtils.getStats(filePath);
        }

        if (!stats) {
            return FileInfo.notFound(
                path.basename(filePath, CONFIG.FILE_EXTENSION)
            );
        }

        const content = FileUtils.readFile(filePath);
        if (!content) {
            return FileInfo.notFound(
                path.basename(filePath, CONFIG.FILE_EXTENSION)
            );
        }

        try {
            const frontmatter = FrontmatterParser.parse(content);
            const fileInfo = FileInfo.fromFrontmatter(frontmatter, filePath);

            this.cache.set(
                filePath,
                new CacheEntry(fileInfo, stats.mtime.getTime())
            );
            return fileInfo;
        } catch (error) {
            logger.log(`파일 캐싱 실패: ${filePath}`, error.message);
            return FileInfo.notFound(
                path.basename(filePath, CONFIG.FILE_EXTENSION)
            );
        }
    }

    findFile(targetPath) {
        if (!targetPath || typeof targetPath !== "string") return null;

        const exactMatch = this.fileIndex.get(targetPath.toLowerCase());
        if (exactMatch) return exactMatch;

        const fileName = path.basename(targetPath).toLowerCase();
        return this.fileIndex.get(fileName) || null;
    }

    searchFiles(query, wikiRoot) {
        if (!wikiRoot) return [];

        const results = [];
        const queryLower = (query || "").toLowerCase();

        for (const [key, fullPath] of this.fileIndex.entries()) {
            // 빈 문자열이면 모든 파일 반환, 아니면 필터링
            if (query === "" || key.includes(queryLower)) {
                try {
                    const relativePath = FileUtils.removeExtension(
                        path.relative(wikiRoot, fullPath)
                    );

                    if (!results.find((r) => r.path === relativePath)) {
                        results.push({
                            path: relativePath,
                            fullPath: fullPath,
                            fileName: path.basename(relativePath),
                        });
                    }
                } catch (error) {
                    logger.log(`파일 검색 중 오류: ${fullPath}`, error.message);
                }
            }
        }

        return results.slice(0, CONFIG.MAX_COMPLETION_RESULTS);
    }

    getStats() {
        return {
            cacheSize: this.cache.size,
            indexSize: this.fileIndex.size,
            lastScan: new Date(this.lastScan).toISOString(),
            initialized: this.initialized,
        };
    }
}

// 위키 파일 Resolver
class WikiFileResolver {
    constructor(fileCache, wikiRoot) {
        this.fileCache = fileCache;
        this.wikiRoot = wikiRoot;
    }

    async resolveForHover(wikiLink, currentDir) {
        if (!wikiLink || !currentDir || !this.wikiRoot) return null;

        try {
            await this.fileCache.initialize(this.wikiRoot);
            this.fileCache.scanDirectory(this.wikiRoot);

            let targetPath = PathUtils.resolveWikiPath(
                wikiLink,
                currentDir,
                this.wikiRoot
            );
            if (!targetPath) return null;

            if (!FileUtils.exists(targetPath)) {
                const foundPath = this.fileCache.findFile(wikiLink);
                if (!foundPath) return null;
                targetPath = foundPath;
            }

            return this.fileCache.getFileInfo(targetPath);
        } catch (error) {
            logger.log(`파일 해결 실패: ${wikiLink}`, error.message);
            return null;
        }
    }

    async searchForCompletion(query, currentDocumentUri) {
        if (!currentDocumentUri || !this.wikiRoot) {
            logger.log("currentDocumentUri 또는 wikiRoot가 정의되지 않음");
            return [];
        }

        try {
            await this.fileCache.initialize(this.wikiRoot);
            this.fileCache.scanDirectory(this.wikiRoot);

            const currentDocPath = currentDocumentUri.replace("file://", "");
            const currentDir = path.dirname(currentDocPath);

            if (!currentDir) {
                logger.log("currentDir를 결정할 수 없음:", currentDocPath);
                return [];
            }

            return this.fileCache
                .searchFiles(query, this.wikiRoot)
                .map((result) =>
                    this._createCompletionItem(result, currentDir)
                );
        } catch (error) {
            logger.log("자동완성 검색 실패:", error.message);
            return [];
        }
    }

    _createCompletionItem(
        { path: relativePath, fullPath, fileName },
        currentDir
    ) {
        if (
            !currentDir ||
            !this.wikiRoot ||
            !relativePath ||
            !fullPath ||
            !fileName
        ) {
            return {
                label: fileName || "알 수 없음",
                kind: CompletionItemKind.File,
                insertText: fileName || "",
            };
        }

        try {
            const targetPath = path.join(
                this.wikiRoot,
                relativePath + CONFIG.FILE_EXTENSION
            );
            const insertPath = PathUtils.getRelativePath(
                currentDir,
                targetPath
            );
            const fileInfo = this.fileCache.getFileInfo(fullPath);
            const displayDir = PathUtils.getDisplayDirectory(relativePath);

            return {
                label: fileName,
                labelDetails: { description: displayDir },
                kind: CompletionItemKind.File,
                detail: displayDir,
                documentation: {
                    kind: MarkupKind.Markdown,
                    value: fileInfo.toCompletionDocumentation(),
                },
                sortText: insertPath.toLowerCase(),
                insertText: insertPath,
            };
        } catch (error) {
            logger.log("완성 항목 생성 실패:", error.message);
            return {
                label: fileName,
                kind: CompletionItemKind.File,
                insertText: fileName,
            };
        }
    }
}

// 메인 LSP 서버
class WikiLSP {
    constructor() {
        this.connection = createConnection(process.stdin, process.stdout);
        this.documents = new TextDocuments(TextDocument);
        this.fileCache = new FileCache();
        this.wikiRoot = "";
        this.resolver = null;

        this._setupHandlers();
    }

    _setupHandlers() {
        this.connection.onInitialize(this._handleInitialize.bind(this));
        this.connection.onHover(this._handleHover.bind(this));
        this.connection.onCompletion(this._handleCompletion.bind(this));
        this.connection.onRequest("wiki/cacheStats", () =>
            this.fileCache.getStats()
        );

        this.documents.listen(this.connection);
    }

    _handleInitialize(params) {
        try {
            this.wikiRoot = params.initializationOptions?.wikiRoot || "./wiki";
            this.resolver = new WikiFileResolver(this.fileCache, this.wikiRoot);

            // 백그라운드에서 초기화 (비블로킹)
            this.fileCache.initialize(this.wikiRoot).catch((error) => {
                logger.log("캐시 초기화 실패:", error.message);
            });

            return {
                capabilities: {
                    textDocumentSync: TextDocumentSyncKind.Incremental,
                    completionProvider: { triggerCharacters: ["["] },
                    hoverProvider: true,
                },
            };
        } catch (error) {
            logger.log("LSP 초기화 실패:", error.message);
            return { capabilities: {} };
        }
    }

    async _handleHover({ textDocument, position }) {
        try {
            const doc = this.documents.get(textDocument.uri);
            if (!doc) return null;

            const lines = doc.getText().split("\n");
            if (!lines[position.line]) return null;

            const line = lines[position.line];
            const wikiLink = WikiLinkParser.extract(line, position.character);
            if (!wikiLink) return null;

            const currentDir = path.dirname(
                textDocument.uri.replace("file://", "")
            );
            const fileInfo = await this.resolver.resolveForHover(
                wikiLink,
                currentDir
            );

            if (!fileInfo || !fileInfo.exists) {
                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: `**${wikiLink}**\n\n*파일을 찾을 수 없음*`,
                    },
                };
            }

            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: fileInfo.toHoverContent(),
                },
            };
        } catch (error) {
            logger.log("호버 처리 실패:", error.message);
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: `**오류**\n\n파일 정보를 불러올 수 없음`,
                },
            };
        }
    }

    async _handleCompletion({ textDocument, position }) {
        try {
            const doc = this.documents.get(textDocument.uri);
            if (!doc) return [];

            const lines = doc.getText().split("\n");
            if (!lines[position.line]) return [];

            const line = lines[position.line];
            const query = WikiLinkParser.findCompletionTrigger(
                line,
                position.character
            );

            // query가 null이 아니면 자동완성 제공 (빈 문자열도 포함)
            if (query !== null) {
                return await this.resolver.searchForCompletion(
                    query,
                    textDocument.uri
                );
            }

            return [];
        } catch (error) {
            logger.log("자동완성 처리 실패:", error.message);
            return [];
        }
    }

    start() {
        this.connection.listen();
    }
}

// 서버 초기화 및 시작
const server = new WikiLSP();
server.start();
