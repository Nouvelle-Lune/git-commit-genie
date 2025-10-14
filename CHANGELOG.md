# Changelog

## [2.1.7]
- fix: Update English UI text for better clarity.

## [2.1.6]
- fix: Added spport for .ipynb files commit message generation.
- fix: Simplified binary file content reading to generate commit messages, saving unnecessary tokens.
- feat: Added a repository analysis cache cleanup command. The current repository analysis cache primarily includes summaries of the technology stack and characteristics of the repository.

## [2.1.3]
- fix: Enhanced retry logic with schema validation and improved error handling in Anthropic and DeepSeek provider.

## [2.1.0]
- feat: Now genie will show stage notifications when using thinking mode.

## [2.0.0]
- feat: Now can use different modle for repository analysis and commit message generation.
- feat: Add LLM cost tracking for this plugin, and display cost details in the VS Code output channel.
- feat: Ensuring generated commit messages better adhere to the user templates.
- feat: Added intelligent repository analysis context for enhanced commit message generation
- fix: Improved the commit message generation for renamed files

## [1.5.0]
- feat: Improved commit message generation in chain-of-thought mode by refining prompt structure and reducing token usage.
- feat: add typing animation when generating commit messages.
- feat: Replaced all console logging with a dedicated logger service that uses VS Code's output channel for better log management and user experience.
- feat: Improved user template system, now can use different templates for different repositories.

## [1.1.0]

- feat: Optimized the language detection logic for commit messages generated during chain-of-thought reasoning, reducing token consumption.
- feat: Enhanced the accuracy of commit messages generated using user templates.

## [1.0.0]

Never suffer through writing commit messages again.

🎉 The first release brings smart commit generation powered by multiple LLM providers, with multilingual support built in.
A simple start, focused on making your workflow smoother and faster.