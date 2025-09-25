import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { IRepositoryScanner, RepositoryScanResult, AnalysisConfig } from './analysisTypes';
import { logger } from '../logger';

/**
 * Repository scanner implementation
 */
export class RepositoryScanner implements IRepositoryScanner {
    private static readonly CONFIGURATION_FILES = [
        'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
        'requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile',
        'pom.xml', 'build.gradle', 'build.gradle.kts', 'gradle.properties',
        'Cargo.toml', 'Cargo.lock',
        'go.mod', 'go.sum',
        'composer.json', 'composer.lock',
        'Gemfile', 'Gemfile.lock',
        'tsconfig.json', 'jsconfig.json',
        'webpack.config.js', 'vite.config.js', 'rollup.config.js',
        'eslint.config.js', '.eslintrc.js', '.eslintrc.json',
        'prettier.config.js', '.prettierrc',
        'jest.config.js', 'vitest.config.js',
        'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
        '.env.example', '.env.template',
        'manifest.json', 'angular.json', 'vue.config.js',
        'next.config.js', 'nuxt.config.js',
        'gatsby-config.js', 'svelte.config.js',
        'tailwind.config.js', 'postcss.config.js'
    ];

    private static readonly README_PATTERNS = [
        'README.md', 'README.rst', 'README.txt', 'README',
        'readme.md', 'readme.rst', 'readme.txt', 'readme'
    ];

    private static readonly KEY_DIRECTORIES = [
        'src', 'lib', 'app', 'pages', 'components', 'utils', 'helpers',
        'services', 'api', 'routes', 'controllers', 'models', 'views',
        'public', 'assets', 'static',
        'test', 'tests', '__tests__', 'spec', 'cypress', 'e2e',
        'docs', 'documentation', 'wiki',
        'config', 'configs', 'settings',
        'scripts', 'tools', 'bin',
        'types', 'typings', '@types',
        'locales', 'i18n', 'translations',
        'styles', 'css', 'scss', 'sass', 'less',
        'images', 'img', 'icons', 'fonts',
        'migrations', 'seeds', 'fixtures',
        'middleware', 'plugins', 'extensions',
        'workers', 'jobs', 'tasks',
        'templates', 'layouts', 'partials'
    ];

    // Max directory depth to search for configuration files (0=root, 1=first-level, 2=second-level)
    private static readonly CONFIG_SCAN_MAX_DEPTH = 3;

    // Default directories to ignore during scanning
    private static readonly DEFAULT_IGNORE_DIRECTORIES = [
        "node_modules",
        "__pycache__",
        "env",
        "venv",
        "target/dependency",
        "build/dependencies",
        "dist",
        "out",
        "bundle",
        "vendor",
        "tmp",
        "temp",
        "deps",
        "Pods",
        "build",
        "target"
    ];

    private config: AnalysisConfig;

    constructor(config: AnalysisConfig) {
        this.config = config;
    }

    async scanRepository(repositoryPath: string): Promise<RepositoryScanResult> {
        const startTime = Date.now();

        try {
            const scanResult: RepositoryScanResult = {
                keyDirectories: [],
                importantFiles: [],
                configFiles: {},
                scannedFileCount: 0,
                scanDuration: 0
            };

            // Get ignore patterns
            const ignorePatterns = await this.getIgnorePatterns(repositoryPath);
            const ignoreRules = this.compileIgnorePatterns(ignorePatterns);

            // Scan for key directories
            scanResult.keyDirectories = await this.findKeyDirectories(repositoryPath, ignoreRules);

            // Scan for important files
            scanResult.importantFiles = await this.findImportantFiles(repositoryPath, ignoreRules, scanResult.keyDirectories);

            // Read README content
            scanResult.readmeContent = await this.findAndReadReadme(repositoryPath);

            // Read configuration files from the entire repository based on CONFIGURATION_FILES
            const configFilePaths = await this.findConfigurationFiles(repositoryPath, ignoreRules);
            scanResult.configFiles = await this.readConfigFiles(configFilePaths, repositoryPath);

            // Count scanned files (after ignores)
            scanResult.scannedFileCount = await this.countTotalFiles(repositoryPath, ignoreRules);

            // Fallback: if 0 files found, retry with conservative defaults (ignore only common heavy dirs)
            if (scanResult.scannedFileCount === 0) {
                const conservative = [
                    ...RepositoryScanner.DEFAULT_IGNORE_DIRECTORIES,
                    '.git', '.git/**', '.vscode', '.vscode/**', '.idea', '.idea/**'
                ];
                const fallbackRules = this.compileIgnorePatterns(conservative);
                scanResult.scannedFileCount = await this.countTotalFiles(repositoryPath, fallbackRules);
            }

            scanResult.scanDuration = Date.now() - startTime;

            return scanResult;
        } catch (error) {
            logger.error('[Genie][RepoScan] Error scanning repository', error as any);
            return {
                keyDirectories: [],
                importantFiles: [],
                configFiles: {},
                scannedFileCount: 0,
                scanDuration: Date.now() - startTime
            };
        }
    }

    private async getIgnorePatterns(repositoryPath: string): Promise<string[]> {
        const patterns: string[] = [...this.config.excludePatterns];

        // Add default ignore directories as patterns
        for (const dir of RepositoryScanner.DEFAULT_IGNORE_DIRECTORIES) {
            // Also add bare segment to catch root entries
            patterns.push(`${dir}/**`, `**/${dir}/**`, dir);
        }

        // Read .gitignore
        const gitignorePath = path.join(repositoryPath, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, 'utf-8');
                const gitignorePatterns = content
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#'));
                patterns.push(...gitignorePatterns);
            } catch (error) {
                logger.warn('[Genie][RepoScan] Failed to read .gitignore', error as any);
            }
        }

        // Add additional common ignore patterns
        patterns.push(
            '.git/**',
            '*.pyc',
            '.vscode/**',
            '.idea/**',
            '*.log',
            '*.cache',
            '.DS_Store',
            'Thumbs.db'
        );

        return patterns;
    }

    private compileIgnorePatterns(patterns: string[]): Array<{ re: RegExp; dirOnly: boolean }> {
        const rules: Array<{ re: RegExp; dirOnly: boolean }> = [];
        const escape = (s: string) => s.replace(/[.+^${}()|\[\]\\]/g, '\\$&');
        for (let raw of patterns) {
            if (!raw || typeof raw !== 'string') { continue; }
            raw = raw.trim();
            if (!raw) { continue; }
            if (raw.startsWith('./')) { raw = raw.slice(2); }
            // Ignore negation for now
            if (raw.startsWith('!')) { raw = raw.slice(1); }
            if (!raw) { continue; }
            const dirOnly = raw.endsWith('/');
            const anchored = raw.startsWith('/');
            const anyDepth = raw.startsWith('**/');
            let body = raw.replace(/^\/+/, '').replace(/\/$/, '');

            // Bare segment (no glob, no slash): match that name anywhere
            if (!body.includes('*') && !body.includes('?') && !body.includes('/')) {
                const seg = escape(body);
                rules.push({ re: new RegExp(`(^|/)${seg}(/.*)?$`), dirOnly });
                continue;
            }

            const tokens = body.split('/');
            const parts: string[] = [];
            for (const t of tokens) {
                if (t === '**') { parts.push('.*'); continue; }
                let seg = '';
                for (let i = 0; i < t.length; i++) {
                    const ch = t[i];
                    if (ch === '*') { seg += '[^/]*'; }
                    else if (ch === '?') { seg += '[^/]'; }
                    else { seg += escape(ch); }
                }
                parts.push(seg);
            }
            const prefix = anchored ? '^' : anyDepth ? '(^|.*/)' : '^';
            const core = parts.join('/');
            // Make directory patterns also match descendants
            const rx = new RegExp(prefix + core + '(/.*)?$');
            rules.push({ re: rx, dirOnly });
        }
        return rules;
    }

    private async findKeyDirectories(repositoryPath: string, ignoreRules: Array<{ re: RegExp; dirOnly: boolean }>): Promise<string[]> {
        const foundDirectories: string[] = [];

        try {
            const entries = fs.readdirSync(repositoryPath, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }

                const dirPath = path.join(repositoryPath, entry.name);
                const relativePath = path.relative(repositoryPath, dirPath);

                if (this.shouldIgnore(relativePath, true, ignoreRules)) {
                    continue;
                }

                if (RepositoryScanner.KEY_DIRECTORIES.includes(entry.name.toLowerCase())) {
                    foundDirectories.push(entry.name);
                }
            }
        } catch (error) {
            logger.warn('[Genie][RepoScan] Failed to scan directories', error as any);
        }

        return foundDirectories;
    }

    private async findImportantFiles(
        repositoryPath: string,
        ignoreRules: Array<{ re: RegExp; dirOnly: boolean }>,
        keyDirectories: string[]
    ): Promise<{ path: string; content?: string }[]> {
        const found: Set<string> = new Set();
        const keyDirSet = new Set(keyDirectories.map(d => d.toLowerCase()));
        // Iterative DFS with caps for performance
        const stack: Array<{ dir: string; depth: number }> = [{ dir: repositoryPath, depth: 0 }];
        const maxDepth = 6;
        const maxFound = 256;
        while (stack.length > 0 && found.size < maxFound) {
            const { dir, depth } = stack.pop()!;
            if (depth > maxDepth) { continue; }
            let entries: fs.Dirent[] = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const rel = path.relative(repositoryPath, fullPath).replace(/\\/g, '/');
                const isDir = entry.isDirectory();
                if (this.shouldIgnore(rel, isDir, ignoreRules)) { continue; }
                if (entry.isFile()) {
                    const firstSeg = rel.split('/')[0]?.toLowerCase() || '';
                    if (keyDirSet.has(firstSeg)) {
                        found.add(rel);
                    }
                } else if (isDir) {
                    stack.push({ dir: fullPath, depth: depth + 1 });
                }
                if (found.size >= maxFound) { break; }
            }
        }
        return Array.from(found).map(p => ({ path: p }));
    }

    private async findAndReadReadme(repositoryPath: string): Promise<string | undefined> {
        for (const readmeFile of RepositoryScanner.README_PATTERNS) {
            const readmePath = path.join(repositoryPath, readmeFile);
            if (fs.existsSync(readmePath)) {
                try {
                    const content = fs.readFileSync(readmePath, 'utf-8');
                    return content;
                } catch (error) {
                    logger.warn(`[Genie][RepoScan] Failed to read README ${readmeFile}`, error as any);
                }
            }
        }
        return undefined;
    }

    private async readConfigFiles(filePaths: string[], repositoryPath: string): Promise<{ [filename: string]: string }> {
        const configFiles: { [filename: string]: string } = {};
        const targetNames = new Set(RepositoryScanner.CONFIGURATION_FILES.map(n => n.toLowerCase()));
        // Limit the number of config files we read to avoid excessive I/O in very large repos
        const maxRead = 10;
        for (const relPath of filePaths.slice(0, maxRead)) {
            try {
                const filePath = path.join(repositoryPath, relPath);
                const content = fs.readFileSync(filePath, 'utf-8');
                // Always store full relative path
                configFiles[relPath] = content.substring(0, 2000);
                // Also store by base name for known config files (helps detection heuristics)
                const base = path.basename(relPath);
                if (targetNames.has(base.toLowerCase())) {
                    // Prefer root-level file; otherwise first encountered wins
                    if (!configFiles[base] || relPath === base) {
                        configFiles[base] = content.substring(0, 2000);
                    }
                }
            } catch (error) {
                logger.warn(`[Genie][RepoScan] Failed to read config file ${relPath}`, error as any);
            }
        }
        return configFiles;
    }

    private async findConfigurationFiles(
        repositoryPath: string,
        ignoreRules: Array<{ re: RegExp; dirOnly: boolean }>
    ): Promise<string[]> {
        const found: Set<string> = new Set();
        const targetNames = new Set(RepositoryScanner.CONFIGURATION_FILES.map(n => n.toLowerCase()));

        // Iterative DFS with caps: limit directory depth and total files visited
        const stack: Array<{ dir: string; depth: number }> = [{ dir: repositoryPath, depth: 0 }];
        const maxScan = 200000; // cap to avoid pathological repos
        let visitedFiles = 0;

        while (stack.length > 0 && visitedFiles < maxScan) {
            const { dir, depth } = stack.pop()!;
            let entries: fs.Dirent[] = [];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const rel = path.relative(repositoryPath, fullPath).replace(/\\/g, '/');
                const isDir = entry.isDirectory();
                if (this.shouldIgnore(rel, isDir, ignoreRules)) { continue; }
                if (entry.isFile()) {
                    visitedFiles++;
                    if (targetNames.has(entry.name.toLowerCase())) {
                        found.add(rel);
                    }
                    if (visitedFiles >= maxScan) { break; }
                } else if (isDir) {
                    // Only traverse deeper if within configured depth
                    if (depth < RepositoryScanner.CONFIG_SCAN_MAX_DEPTH) {
                        // Avoid symlink loops
                        try {
                            const st = fs.lstatSync(fullPath);
                            if (st.isSymbolicLink()) { continue; }
                        } catch { /* ignore */ }
                        stack.push({ dir: fullPath, depth: depth + 1 });
                    }
                }
            }
        }
        return Array.from(found);
    }

    private async countTotalFiles(repositoryPath: string, ignoreRules: Array<{ re: RegExp; dirOnly: boolean }>): Promise<number> {
        let count = 0;
        const maxCount = 200000; // safety cap for very large repos
        const stack: string[] = [repositoryPath];
        while (stack.length > 0 && count < maxCount) {
            const dirPath = stack.pop()!;
            let entries: fs.Dirent[] = [];
            try {
                entries = fs.readdirSync(dirPath, { withFileTypes: true });
            } catch (error) {
                // Skip directories we cannot read
                logger.warn('[Genie][RepoScan] Failed to count files', error as any);
                continue;
            }
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                const rel = path.relative(repositoryPath, fullPath).replace(/\\/g, '/');
                const isDir = entry.isDirectory();
                if (this.shouldIgnore(rel, isDir, ignoreRules)) { continue; }
                if (entry.isFile()) {
                    count++;
                    if (count >= maxCount) { break; }
                } else if (isDir) {
                    // Avoid symlink loops
                    try {
                        const st = fs.lstatSync(fullPath);
                        if (st.isSymbolicLink()) { continue; }
                    } catch { /* ignore */ }
                    stack.push(fullPath);
                }
            }
        }
        return count;
    }

    private shouldIgnore(relativePath: string, isDirectory: boolean, ignoreRules: Array<{ re: RegExp; dirOnly: boolean }>): boolean {
        const normalizedPath = relativePath.replace(/\\/g, '/');
        const candidate = isDirectory && !normalizedPath.endsWith('/') ? normalizedPath + '/' : normalizedPath;
        for (const rule of ignoreRules) {
            if (rule.re.test(candidate)) { return true; }
        }
        return false;
    }
}
