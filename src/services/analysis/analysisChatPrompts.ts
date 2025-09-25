import { LLMAnalysisRequest } from './analysisTypes';

export interface AnalysisPromptParts {
    system: string;
    user: string;
}

export function buildRepositoryAnalysisPromptParts(request: LLMAnalysisRequest): AnalysisPromptParts {
    return buildPromptPartsWithTokenLimit(request);
}

function buildPromptPartsWithTokenLimit(request: LLMAnalysisRequest): AnalysisPromptParts {
    const strategies = [
        () => buildFullPromptParts(request),
        () => buildReducedPromptParts(request),
        () => buildMinimalPromptParts(request)
    ];

    const MAX_TOKEN_ESTIMATE = 10000;
    for (const strategy of strategies) {
        const parts = strategy();
        const combined = `${parts.system}\n\n${parts.user}`;
        if (estimateTokenCount(combined) <= MAX_TOKEN_ESTIMATE) {
            return parts;
        }
    }
    return buildMinimalPromptParts(request);
}



function buildFullPromptParts(request: LLMAnalysisRequest): AnalysisPromptParts {
    const { scanResult, previousAnalysis, recentCommits, repositoryPath } = request;

    const system = [
        '<role>',
        'You are an expert software engineer analyzing a code repository.',
        '</role>',
        '',
        '<critical>',
        'Return STRICT JSON only; do not include markdown or code fences.',
        'The final assistant message MUST be a single JSON object matching the schema.',
        '</critical>',
        '',
        '<instructions>',
        'If the previous analysis is provided, focus on changes and new insights since then. Otherwise, provide a comprehensive analysis including:',
        '- Project summary and purpose',
        '- Technology stack identification',
        '- Architectural insights',
        '- Key observations about the codebase',
        '</instructions>',
        '',
        '<constraints>',
        '- Keep summary concise but informative (200-500 words)',
        '- Focus on the most important aspects that would help understand the codebase',
        '- Base analysis on actual code and configuration files provided',
        '- Consider previous analysis for consistency if provided',
        '</constraints>',
        '',
        '<schema>',
        '{',
        '  "summary": "Brief but comprehensive summary of the repository purpose and architecture",',
        '  "projectType": "Main project type (e.g., Web App, Library, CLI Tool, etc.)",',
        '  "technologies": ["array", "of", "main", "technologies", "used"],',
        '  "insights": ["key", "architectural", "insights", "about", "the", "project"]',
        '}',
        '</schema>'
    ].join('\n');

    const userParts: string[] = [
        '<input>',
        '## Repository Scan Results:',
        `- Repository Path: ${repositoryPath}`,
        `- Key Directories: ${scanResult.keyDirectories.join(', ')}`,
        `- Important Files: ${scanResult.importantFiles.map(f => f.path).join(', ')}`,
        `- Scanned Files: ${scanResult.scannedFileCount}`,
        ''
    ];

    if (scanResult.readmeContent) {
        userParts.push(
            '## README Content:',
            '```',
            scanResult.readmeContent.substring(0, 3000),
            '```',
            ''
        );
    }

    const configEntries = Object.entries(scanResult.configFiles);
    if (configEntries.length > 0) {
        userParts.push('## Key Configuration Files:');
        for (const [filename, content] of configEntries.slice(0, 5)) {
            userParts.push(
                `### ${filename}:`,
                '```',
                content.substring(0, 1500),
                '```',
                ''
            );
        }
    }

    if (previousAnalysis) {
        userParts.push(
            '## Previous Analysis:',
            `Project Type: ${previousAnalysis.projectType}`,
            `Technologies: ${previousAnalysis.technologies.join(', ')}`,
            `Summary: ${previousAnalysis.summary}`,
            `Insights: ${previousAnalysis.insights?.join('; ') || 'N/A'}`,
            ''
        );
    }

    if (recentCommits && recentCommits.length > 0) {
        userParts.push(
            '## Recent Commit Messages:',
            ...recentCommits.slice(0, 5).map(msg => `- ${msg}`),
            ''
        );
    }

    userParts.push(
        '</input>',
        '',
        '<output>',
        'Please respond with a JSON object following the schema defined above.',
        '</output>'
    );

    return {
        system,
        user: userParts.join('\n')
    };
}



function buildReducedPromptParts(request: LLMAnalysisRequest): AnalysisPromptParts {
    const { scanResult, previousAnalysis, recentCommits, repositoryPath } = request;

    const system = [
        '<role>',
        'You are an expert software engineer analyzing a code repository.',
        '</role>',
        '',
        '<critical>',
        'Return STRICT JSON only; do not include markdown or code fences.',
        'The final assistant message MUST be a single JSON object matching the schema.',
        '</critical>',
        '',
        '<instructions>',
        'If the previous analysis is provided, focus on changes and new insights since then. Otherwise, provide a structured analysis:',
        '</instructions>',
        '',
        '<constraints>',
        '- Keep summary concise (200-400 words)',
        '- Focus on key aspects of the codebase',
        '</constraints>',
        '',
        '<schema>',
        '{',
        '  "summary": "Brief summary of the repository purpose and architecture",',
        '  "projectType": "Main project type",',
        '  "technologies": ["main", "technologies", "used"],',
        '  "insights": ["key", "insights"]',
        '}',
        '</schema>'
    ].join('\n');

    const userParts: string[] = [
        '<input>',
        '## Repository Scan Results:',
        `- Repository Path: ${repositoryPath}`,
        `- Key Directories: ${scanResult.keyDirectories.join(', ')}`,
        `- Important Files: ${scanResult.importantFiles.map(f => f.path).join(', ')}`,
        `- Scanned Files: ${scanResult.scannedFileCount}`,
        ''
    ];

    if (scanResult.readmeContent) {
        userParts.push(
            '## README Content:',
            '```',
            scanResult.readmeContent.substring(0, 1500),
            '```',
            ''
        );
    }

    const configEntries = Object.entries(scanResult.configFiles);
    if (configEntries.length > 0) {
        userParts.push('## Key Configuration Files:');
        for (const [filename, content] of configEntries.slice(0, 3)) {
            userParts.push(
                `### ${filename}:`,
                '```',
                content.substring(0, 800),
                '```',
                ''
            );
        }
    }

    if (previousAnalysis) {
        userParts.push(
            '## Previous Analysis:',
            `Project Type: ${previousAnalysis.projectType}`,
            `Technologies: ${previousAnalysis.technologies.join(', ')}`,
            `Summary: ${previousAnalysis.summary}`,
            ''
        );
    }

    if (recentCommits && recentCommits.length > 0) {
        userParts.push(
            '## Recent Commit Messages:',
            ...recentCommits.slice(0, 5).map(msg => `- ${msg}`),
            ''
        );
    }

    userParts.push(
        '</input>',
        '',
        '<output>',
        'Please respond with a JSON object following the schema.',
        '</output>'
    );

    return {
        system,
        user: userParts.join('\n')
    };
}



function buildMinimalPromptParts(request: LLMAnalysisRequest): AnalysisPromptParts {
    const { scanResult, previousAnalysis, recentCommits, repositoryPath } = request;

    const system = [
        '<role>',
        'You are an expert software engineer analyzing a code repository.',
        '</role>',
        '',
        '<critical>',
        'Return STRICT JSON only; do not include markdown or code fences.',
        'The final assistant message MUST be a single JSON object matching the schema.',
        '</critical>',
        '',
        '<instructions>',
        'Provide a basic structured analysis of the repository.',
        '</instructions>',
        '',
        '<schema>',
        '{',
        '  "summary": "Brief summary",',
        '  "projectType": "Project type",',
        '  "technologies": ["technologies"],',
        '  "insights": ["insights"]',
        '}',
        '</schema>'
    ].join('\n');

    const userParts: string[] = [
        '<input>',
        '## Repository Scan Results:',
        `- Repository Path: ${repositoryPath}`,
        `- Key Directories: ${scanResult.keyDirectories.join(', ')}`,
        `- Important Files: ${scanResult.importantFiles.map(f => f.path).join(', ')}`,
        `- Scanned Files: ${scanResult.scannedFileCount}`,
        '',
    ];

    const configEntries = Object.entries(scanResult.configFiles);
    const mostImportant = configEntries.filter(([filename]) =>
        ['package.json', 'pom.xml', 'requirements.txt', 'Cargo.toml'].includes(filename)
    );

    if (mostImportant.length > 0) {
        userParts.push('## Key Configuration Files:');
        for (const [filename, content] of mostImportant.slice(0, 2)) {
            userParts.push(
                `### ${filename}:`,
                '```',
                content.substring(0, 400),
                '```',
                ''
            );
        }
    }

    if (previousAnalysis) {
        userParts.push(
            '## Previous Analysis:',
            `Project Type: ${previousAnalysis.projectType}`,
            `Technologies: ${previousAnalysis.technologies.join(', ')}`,
            `Summary: ${previousAnalysis.summary}`,
            ''
        );
    }

    if (recentCommits && recentCommits.length > 0) {
        userParts.push(
            '## Recent Commit Messages:',
            ...recentCommits.slice(0, 5).map(msg => `- ${msg}`),
            ''
        );
    }

    userParts.push(
        '</input>',
        '',
        '<output>',
        'Please respond with a JSON object following the schema.',
        '</output>'
    );

    return {
        system,
        user: userParts.join('\n')
    };
}



function estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
}
