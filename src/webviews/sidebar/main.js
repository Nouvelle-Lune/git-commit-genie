// @ts-ignore

const vscode = acquireVsCodeApi();

window.addEventListener('message', event => {
    const message = event.data; // The JSON data our extension sent

    switch (message.command) {
        case 'response':
            {
                const responseArea = document.getElementById('response-area');
                responseArea.innerHTML = ''; // Clear previous response

                const lines = message.content.split('\n');
                const commitMessage = lines.slice(0, lines.length - 1).join('\n');
                const gitCommand = lines[lines.length - 1];

                const commitMessageElement = document.createElement('div');
                commitMessageElement.innerText = commitMessage;
                responseArea.appendChild(commitMessageElement);

                const commandElement = document.createElement('div');
                commandElement.innerText = gitCommand;
                responseArea.appendChild(commandElement);

                const buttonContainer = document.createElement('div');

                const acceptButton = document.createElement('button');
                acceptButton.innerText = 'Accept';
                acceptButton.addEventListener('click', () => {
                    vscode.postMessage({
                        command: 'execute',
                        gitCommand: gitCommand
                    });
                });
                buttonContainer.appendChild(acceptButton);

                const rejectButton = document.createElement('button');
                rejectButton.innerText = 'Reject';
                rejectButton.addEventListener('click', () => {
                    responseArea.innerHTML = '';
                });
                buttonContainer.appendChild(rejectButton);

                responseArea.appendChild(buttonContainer);
                break;
            }
    }
});

document.getElementById('submit-button').addEventListener('click', () => {
    const promptInput = document.getElementById('prompt-input');
    const prompt = promptInput.value;
    vscode.postMessage({
        command: 'submit',
        prompt: prompt
    });
});

document.getElementById('settings-button').addEventListener('click', () => {
    vscode.postMessage({
        command: 'openSettings'
    });
});