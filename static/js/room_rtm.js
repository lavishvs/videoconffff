var messages = [];
var participants = [];
var participantProfiles = {};
var fallbackRoomActive = false;
var fallbackPollTimer = null;
var fallbackHeartbeatTimer = null;
var fallbackLastMessageId = 0;

let escapeHTML = (value) => {
    let element = document.createElement('div');
    element.textContent = value == null ? '' : String(value);
    return element.innerHTML;
}

let normaliseMemberId = (memberId) => String(memberId);

let refreshParticipantsArray = () => {
    participants = Object.values(participantProfiles);
}

let fetchMemberName = async (memberId) => {
    try {
        let attributes = await rtmClient.getUserAttributesByKeys(memberId, ['name']);
        return attributes.name || memberId;
    } catch (err) {
        console.warn('Could not fetch member name:', memberId, err);
        return memberId;
    }
}

let getParticipantName = (memberId) => {
    return participantProfiles[normaliseMemberId(memberId)] || `User ${memberId}`;
}

let addMemberProfileToDom = (memberId, name) => {
    let memberKey = normaliseMemberId(memberId);
    participantProfiles[memberKey] = name || memberKey;
    refreshParticipantsArray();

    let membersWrapper = document.getElementById('member__list');
    if (!membersWrapper) {
        console.warn('member__list element not found');
        return;
    }

    let existingMember = document.getElementById(`member__${memberKey}__wrapper`);
    if (existingMember) {
        let nameElement = existingMember.getElementsByClassName('member_name')[0];
        if (nameElement) {
            nameElement.textContent = participantProfiles[memberKey];
        }
        return;
    }

    let memberItem = `<div class="member__wrapper" id="member__${memberKey}__wrapper">
                    <span class="green__icon"></span>
                    <p class="member_name">${escapeHTML(participantProfiles[memberKey])}</p>
                </div>`;

    membersWrapper.insertAdjacentHTML('beforeend', memberItem);
}

let handleMemberJoined = async (memberId) => {
    console.log('A new member has joined the room:', memberId);
    await addMemberToDom(memberId);

    let members = await refreshMemberTotal();
    updateMemberTotal(members);

    let name = getParticipantName(memberId);
    addSystemMessageToDom(`Welcome to the room ${name}!`);
}

let addMemberToDom = async (memberId) => {
    let memberKey = normaliseMemberId(memberId);
    let name = await fetchMemberName(memberId);

    addMemberProfileToDom(memberKey, name || memberKey);
}

let updateMemberTotal = (membersOrCount) => {
    let total = document.getElementById('members__count');
    if (!total) {
        console.warn('members__count element not found');
        return;
    }

    let count = Array.isArray(membersOrCount) ? membersOrCount.length : Number(membersOrCount);
    if (!Number.isFinite(count)) {
        count = Object.keys(participantProfiles).length;
    }

    total.innerText = count;
}

let refreshMemberTotal = async () => {
    try {
        if (!channel) {
            updateMemberTotal(Object.keys(participantProfiles).length);
            return Object.keys(participantProfiles);
        }

        let members = await channel.getMembers();
        updateMemberTotal(members);
        return members;
    } catch (err) {
        console.warn('Could not refresh member total:', err);
        updateMemberTotal(Object.keys(participantProfiles).length);
        return Object.keys(participantProfiles);
    }
}

let handleMemberLeft = async (memberId) => {
    let name = removeMemberFromDom(memberId);
    await refreshMemberTotal();

    if (name) {
        addSystemMessageToDom(`${name} has left the room.`);
    }
}

let removeMemberFromDom = (memberId) => {
    let memberKey = normaliseMemberId(memberId);
    let memberWrapper = document.getElementById(`member__${memberKey}__wrapper`);
    let name = participantProfiles[memberKey];

    if (!name && memberWrapper) {
        let nameElement = memberWrapper.getElementsByClassName('member_name')[0];
        name = nameElement ? nameElement.textContent : memberKey;
    }

    delete participantProfiles[memberKey];
    refreshParticipantsArray();

    if (memberWrapper) {
        memberWrapper.remove();
    }

    return name;
}

let getMembers = async () => {
    let members = await refreshMemberTotal();
    let membersWrapper = document.getElementById('member__list');

    participantProfiles = {};
    participants = [];

    if (membersWrapper) {
        membersWrapper.innerHTML = '';
    }

    for (let i = 0; members.length > i; i++) {
        await addMemberToDom(members[i]);
    }

    updateMemberTotal(members);
}

let handleChannelMessage = async (messageData, memberId) => {
    let data;
    try {
        data = JSON.parse(messageData.text);
    } catch (err) {
        console.warn('Received invalid RTM message:', messageData, err);
        return;
    }

    if (data.type === 'chat') {
        addMessageToDom(data.displayName, data.message);
        messages.push({ displayName: data.displayName, message: data.message, type: 'chat' });
    }

    if (data.type === 'file') {
        addFileMessageToDom(data.displayName, data.fileUrl, data.fileName, data.fileType);
        messages.push({ displayName: data.displayName, fileUrl: data.fileUrl, fileName: data.fileName, fileType: data.fileType, type: 'file' });
    }

    if (data.type === 'user_left') {
        let videoContainer = document.getElementById(`user-container-${data.uid}`);
        if (videoContainer) {
            videoContainer.remove();
        }

        if (userIdInDisplayFrame === `user-container-${data.uid}`) {
            displayFrame.style.display = null;
            userIdInDisplayFrame = null;

            for (let i = 0; videoFrames.length > i; i++) {
                videoFrames[i].style.height = '300px';
                videoFrames[i].style.width = '300px';
            }
        }
    }
}

let fallbackRoomUrl = (path = '') => {
    return `/api/rooms/${encodeURIComponent(roomId)}${path}`;
}

let fallbackRoomRequest = async (path, options = {}) => {
    const response = await fetch(fallbackRoomUrl(path), {
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        ...options
    });

    if (!response.ok) {
        throw new Error(await response.text());
    }

    return response.json();
}

let applyFallbackMembers = (members) => {
    let membersWrapper = document.getElementById('member__list');
    participantProfiles = {};
    participants = [];

    if (membersWrapper) {
        membersWrapper.innerHTML = '';
    }

    for (let i = 0; members.length > i; i++) {
        addMemberProfileToDom(members[i].uid, members[i].name);
    }

    updateMemberTotal(members);
}

let appendFallbackMessages = (newMessages) => {
    for (let i = 0; newMessages.length > i; i++) {
        let message = newMessages[i];
        fallbackLastMessageId = Math.max(fallbackLastMessageId, message.id || 0);

        if (message.type === 'chat') {
            addMessageToDom(message.displayName, message.message);
            messages.push({ displayName: message.displayName, message: message.message, type: 'chat' });
        }

        if (message.type === 'file') {
            addFileMessageToDom(message.displayName, message.fileUrl, message.fileName, message.fileType);
            messages.push({
                displayName: message.displayName,
                fileUrl: message.fileUrl,
                fileName: message.fileName,
                fileType: message.fileType,
                type: 'file'
            });
        }
    }
}

let syncFallbackRoomState = async () => {
    if (!fallbackRoomActive) return;

    try {
        let data = await fallbackRoomRequest(`/state?after=${fallbackLastMessageId}`);
        applyFallbackMembers(data.members || []);
        appendFallbackMessages(data.messages || []);
    } catch (err) {
        console.warn('Fallback room sync failed:', err);
    }
}

let sendFallbackMessage = async (payload) => {
    let data = await fallbackRoomRequest('/messages', {
        method: 'POST',
        body: JSON.stringify({
            uid: uid,
            displayName: displayName,
            ...payload
        })
    });

    if (data.message && data.message.id) {
        fallbackLastMessageId = Math.max(fallbackLastMessageId, data.message.id);
    }

    return data.message;
}

let startFallbackRoomSync = async (showMessage = true) => {
    if (fallbackRoomActive) return;

    fallbackRoomActive = true;

    try {
        let data = await fallbackRoomRequest('/join', {
            method: 'POST',
            body: JSON.stringify({ uid: uid, displayName: displayName })
        });

        applyFallbackMembers(data.members || []);
        appendFallbackMessages(data.messages || []);
        if (showMessage) {
            addSystemMessageToDom('Chat connected through the server fallback.');
        }
    } catch (err) {
        fallbackRoomActive = false;
        console.error('Fallback room join failed:', err);
        addSystemMessageToDom('Chat is not connected. Set AGORA_APP_CERTIFICATE or restart the server and try again.');
        return;
    }

    fallbackPollTimer = setInterval(syncFallbackRoomState, 2500);
    fallbackHeartbeatTimer = setInterval(async () => {
        try {
            let data = await fallbackRoomRequest('/heartbeat', {
                method: 'POST',
                body: JSON.stringify({ uid: uid, displayName: displayName })
            });
            applyFallbackMembers(data.members || []);
        } catch (err) {
            console.warn('Fallback room heartbeat failed:', err);
        }
    }, 10000);
}

let stopFallbackRoomSync = () => {
    if (!fallbackRoomActive) return;

    fallbackRoomActive = false;
    clearInterval(fallbackPollTimer);
    clearInterval(fallbackHeartbeatTimer);
    fallbackPollTimer = null;
    fallbackHeartbeatTimer = null;

    try {
        fetch(fallbackRoomUrl('/leave'), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ uid: uid }),
            keepalive: true
        });
    } catch (err) {
        console.warn('Fallback room leave failed:', err);
    }
}

let sendMessage = async (e) => {
    e.preventDefault();

    if (typeof channel === 'undefined' || !channel) {
        if (!fallbackRoomActive) {
            console.error('RTM channel not initialized. Cannot send message.');
            addSystemMessageToDom('Chat is not connected. Try reloading the page or check Agora authentication.');
            return;
        }
    }

    let message = messageInput.value.trim();
    if (message.length === 0) {
        return;
    }

    try {
        if (channel) {
            await channel.sendMessage({ text: JSON.stringify({ type: 'chat', message: message, displayName: displayName }) });
        } else {
            await sendFallbackMessage({ type: 'chat', message: message });
        }
        addMessageToDom(displayName, message);
        messages.push({ displayName: displayName, message: message, type: 'chat' });
    } catch (err) {
        console.error('Failed to send message:', err);
        addSystemMessageToDom('Failed to send message. Chat is not authenticated or the server fallback is unavailable.');
        return;
    }

    messageInput.value = '';

    if (message.toLowerCase().includes('jarvis!') || message.toLowerCase().includes('jarview!')) {
        try {
            const response = await fetch('/api/bot-response', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message: message })
            });

            if (response.ok) {
                const data = await response.json();
                const botMessage = data.bot_message;

                messages.push({ displayName: 'Jarvis AI', message: botMessage, type: 'bot' });
                addBotMessageToDom(botMessage);
            } else {
                let errorData = await response.json().catch(() => ({}));
                addSystemMessageToDom(errorData.error || 'Jarvis AI could not answer right now.');
            }
        } catch (error) {
            console.error('Error:', error);
            addSystemMessageToDom('Jarvis AI could not answer right now.');
        }
    }
}

let handleFileUpload = async () => {
    const fileInput = document.getElementById('file-input');
    const file = fileInput.files[0];
    if (!file) return;

    if ((typeof channel === 'undefined' || !channel) && !fallbackRoomActive) {
        alert('Chat is not connected. Please reload the room and try again.');
        fileInput.value = '';
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/upload-file', {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            const data = await response.json();
            const { file_url, file_name, file_type } = data;

            if (channel) {
                await channel.sendMessage({
                    text: JSON.stringify({
                        type: 'file',
                        fileUrl: file_url,
                        fileName: file_name,
                        fileType: file_type,
                        displayName: displayName
                    })
                });
            } else {
                await sendFallbackMessage({
                    type: 'file',
                    fileUrl: file_url,
                    fileName: file_name,
                    fileType: file_type
                });
            }
            addFileMessageToDom(displayName, file_url, file_name, file_type);
            messages.push({ displayName: displayName, fileUrl: file_url, fileName: file_name, fileType: file_type, type: 'file' });
        } else {
            console.error('File upload failed');
            alert('Failed to upload file. Please login and try again.');
        }
    } catch (error) {
        console.error('Error:', error);
        alert('Error uploading file. Please try again.');
    }

    fileInput.value = '';
}

let addMessageToDom = (name, message) => {
    let messagesWrapper = document.getElementById('messages');

    let newMessage = `<div class="message__wrapper">
                    <div class="message__body">
                        <strong class="message__author">${escapeHTML(name)}</strong>
                        <p class="message__text">${escapeHTML(message)}</p>
                    </div>
                </div>`;

    messagesWrapper.insertAdjacentHTML('beforeend', newMessage);

    let lastMessage = document.querySelector('#messages .message__wrapper:last-child');
    if (lastMessage) {
        lastMessage.scrollIntoView();
    }
}

let addFileMessageToDom = (name, fileUrl, fileName, fileType) => {
    let messagesWrapper = document.getElementById('messages');
    let safeFileUrl = escapeHTML(fileUrl);
    let safeFileName = escapeHTML(fileName);

    let content = '';
    if (fileType && fileType.startsWith('image/')) {
        content = `<img src="${safeFileUrl}" alt="${safeFileName}" class="message__file__image" /><br><a href="${safeFileUrl}" download="${safeFileName}" class="message__file__link">Download ${safeFileName}</a>`;
    } else {
        content = `<a href="${safeFileUrl}" download="${safeFileName}" class="message__file__link">${safeFileName}</a>`;
    }

    let newMessage = `<div class="message__wrapper">
                    <div class="message__body">
                        <strong class="message__author">${escapeHTML(name)}</strong>
                        ${content}
                    </div>
                </div>`;

    messagesWrapper.insertAdjacentHTML('beforeend', newMessage);

    let lastMessage = document.querySelector('#messages .message__wrapper:last-child');
    if (lastMessage) {
        lastMessage.scrollIntoView();
    }
}

let addBotMessageToDom = (botMessage) => {
    let messagesWrapper = document.getElementById('messages');

    let newMessage = `<div class="message__wrapper">
                    <div class="message__body__bot">
                        <strong class="message__author__bot">Jarvis AI</strong>
                        <p class="message__text__bot">${botMessage}</p>
                    </div>
                </div>`;

    messagesWrapper.insertAdjacentHTML('beforeend', newMessage);

    let lastMessage = document.querySelector('#messages .message__wrapper:last-child');
    if (lastMessage) {
        lastMessage.scrollIntoView();
    }
}

let addSystemMessageToDom = (systemMessage) => {
    let messagesWrapper = document.getElementById('messages');

    let newMessage = `<div class="message__wrapper">
                    <div class="message__body__system">
                        <strong class="message__author__system">System</strong>
                        <p class="message__text__system">${escapeHTML(systemMessage)}</p>
                    </div>
                </div>`;

    messagesWrapper.insertAdjacentHTML('beforeend', newMessage);

    let lastMessage = document.querySelector('#messages .message__wrapper:last-child');
    if (lastMessage) {
        lastMessage.scrollIntoView();
    }
}

const messageInput = document.getElementById('message-input');

document.addEventListener('DOMContentLoaded', () => {
    const emojiButton = document.getElementById('emoji-button');
    const emojiPickerContainer = document.getElementById('emoji-picker-container');
    const fileInput = document.getElementById('file-input');

    let pickerVisible = false;

    if (typeof EmojiMart !== 'undefined') {
        const picker = new EmojiMart.Picker({
            onEmojiSelect: (emoji) => {
                if (messageInput) {
                    messageInput.value += emoji.native;
                }
                emojiPickerContainer.style.display = 'none';
                pickerVisible = false;
            }
        });

        emojiPickerContainer.appendChild(picker);

        emojiButton.addEventListener('click', () => {
            pickerVisible = !pickerVisible;
            emojiPickerContainer.style.display = pickerVisible ? 'block' : 'none';
        });

        document.addEventListener('click', (event) => {
            if (!emojiPickerContainer.contains(event.target) && event.target !== emojiButton) {
                emojiPickerContainer.style.display = 'none';
                pickerVisible = false;
            }
        });
    } else {
        console.error('EmojiMart failed to load');
        emojiButton.style.display = 'none';
    }

    fileInput.addEventListener('change', handleFileUpload);
});

let leaveChannel = async () => {
    stopFallbackRoomSync();

    try {
        if (channel) {
            await channel.leave();
        }
    } catch (err) {
        console.warn('Failed to leave RTM channel:', err);
    }

    try {
        if (rtmClient) {
            await rtmClient.logout();
        }
    } catch (err) {
        console.warn('Failed to logout RTM client:', err);
    }
}

window.addEventListener('beforeunload', leaveChannel);

let messageForm = document.getElementById('message__form');
messageForm.addEventListener('submit', sendMessage);
