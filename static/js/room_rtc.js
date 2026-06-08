const APP_ID = WEB_API;

let uid = sessionStorage.getItem('uid');
if (!uid) {
    uid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    sessionStorage.setItem('uid', uid);
}

let client;
let rtmClient;
let channel;

let roomId = (typeof inviteId !== 'undefined' && inviteId) ? inviteId : 'main';

let displayName = sessionStorage.getItem('display_name');
if (!displayName) {
    window.location.href = '/';
}

let localTracks = [];
let remoteUsers = {};

let mediaRecorder;
let localVideoFilePath;
let chunks = [];

let localScreenTracks = null;
let sharingScreen = false;
let rtcJoined = false;
let streamJoined = false;
let audioMuted = false;
let cameraMuted = false;
let tokenlessAgoraJoin = false;
let usingPeerVideoFallback = false;
let peerVideoReady = false;
let peerSignalPollTimer = null;
let peerLastSignalId = 0;
let localPeerStream = null;
let peerConnections = {};

const joinButton = document.getElementById('join-btn');
const cameraButton = document.getElementById('camera-btn');
const micButton = document.getElementById('mic-btn');
const screenButton = document.getElementById('screen-btn');
const recordButton = document.getElementById('record-btn');
const leaveButton = document.getElementById('leave-btn');
const streamActions = document.getElementsByClassName('stream__actions')[0];
const peerConnectionConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

let hasAgoraAppId = () => {
    return APP_ID && APP_ID !== 'None' && APP_ID !== 'null' && APP_ID.trim() !== '';
}

let setJoinButton = (enabled, text = 'Join Stream') => {
    if (!joinButton) return;
    joinButton.disabled = !enabled;
    joinButton.textContent = text;
}

let setStreamActionsVisible = (visible) => {
    if (streamActions) {
        streamActions.style.display = visible ? 'flex' : 'none';
    }
}

let avatarUrl = (name) => {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'Guest')}&rounded=true&background=random&bold=true`;
}

let getTrackList = (tracks) => {
    if (!tracks) return [];
    return Array.isArray(tracks) ? tracks.filter(Boolean) : [tracks];
}

let setTrackEnabled = async (track, enabled) => {
    if (!track) return;

    if (typeof track.setEnabled === 'function') {
        await track.setEnabled(enabled);
        return;
    }

    if (typeof track.setMuted === 'function') {
        await track.setMuted(!enabled);
    }
}

let getMediaSetupErrorMessage = () => {
    if (!window.isSecureContext) {
        return 'Camera access requires HTTPS, localhost, or 127.0.0.1. Open the room from a secure origin and try again.';
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return 'This browser cannot access the camera or microphone from this page. Try a current Chrome, Edge, Firefox, or Safari browser.';
    }

    return null;
}

let getCameraErrorMessage = (err) => {
    let detail = `${err && err.name ? err.name : ''} ${err && err.message ? err.message : ''}`.toLowerCase();

    if (detail.includes('notallowed') || detail.includes('permission') || detail.includes('denied')) {
        return 'Camera or microphone permission was blocked. Allow access in the browser and try joining again.';
    }

    if (detail.includes('notfound') || detail.includes('devicesnotfound')) {
        return 'No camera or microphone was found. Connect a device or choose an available input in the browser.';
    }

    if (detail.includes('notreadable') || detail.includes('trackstarterror')) {
        return 'The camera or microphone is already in use by another app. Close the other app and try again.';
    }

    if (detail.includes('overconstrained') || detail.includes('constraint')) {
        return 'The selected camera does not support the requested video quality. Trying again with a different camera may help.';
    }

    return 'Could not open your camera or microphone. Check browser permissions and try again.';
}

let getAgoraConnectionErrorMessage = (err) => {
    let detail = `${err && err.code ? err.code : ''} ${err && err.message ? err.message : ''}`.toLowerCase();

    if (tokenlessAgoraJoin || detail.includes('dynamic') || detail.includes('token') || detail.includes('certificate')) {
        return 'Video could not connect because this Agora project likely requires tokens. Set AGORA_APP_CERTIFICATE and restart the server.';
    }

    if (detail.includes('invalid') || detail.includes('app id') || detail.includes('appid') || detail.includes('vendor')) {
        return 'Video could not connect because the Agora App ID looks invalid. Check AGORA_API and restart the server.';
    }

    return 'Failed to join video. Check the Agora App ID, App Certificate, and browser console.';
}

let closeTrack = (track) => {
    if (!track) return;
    if (typeof track.stop === 'function') track.stop();
    if (typeof track.close === 'function') track.close();
}

let closeTracks = (tracks) => {
    getTrackList(tracks).forEach(closeTrack);
}

function removeVideoContainer(userUid) {
    let container = document.getElementById(`user-container-${userUid}`);
    if (!container) return;

    if (userIdInDisplayFrame === container.id) {
        displayFrame.style.display = null;
        userIdInDisplayFrame = null;
    }

    container.remove();
    resetVideoFrames();
}

let resetVideoFrames = () => {
    for (let i = 0; videoFrames.length > i; i++) {
        videoFrames[i].style.height = '300px';
        videoFrames[i].style.width = '300px';
    }
}

let createVideoContainer = (userUid, name, parentElement) => {
    let containerId = `user-container-${userUid}`;
    let existingContainer = document.getElementById(containerId);
    if (existingContainer) {
        return existingContainer;
    }

    let player = `<div class="video__container" id="${containerId}" style="background-image: url('${avatarUrl(name)}')">
                <div class="video-player" id="user-${userUid}"></div>
            </div>`;

    parentElement.insertAdjacentHTML('beforeend', player);
    let container = document.getElementById(containerId);
    container.addEventListener('click', expandVideoFrame);
    return container;
}

let createLocalVideoContainer = (parentElement = document.getElementById('streams__container')) => {
    let container = createVideoContainer(uid, displayName, parentElement);
    setLocalVideoAvatar(cameraMuted);
    return container;
}

let setLocalVideoAvatar = (showAvatar) => {
    let videoContainer = document.getElementById(`user-container-${uid}`);
    let videoElement = document.getElementById(`user-${uid}`);

    if (videoContainer) {
        videoContainer.style.backgroundImage = showAvatar ? `url('${avatarUrl(displayName)}')` : 'none';
    }

    if (videoElement) {
        videoElement.style.display = showAvatar ? 'none' : 'block';
    }
}

let getDisplayNameForUid = async (userUid) => {
    let memberKey = String(userUid);

    if (typeof getParticipantName === 'function' && participantProfiles[memberKey]) {
        return getParticipantName(memberKey);
    }

    if (rtmClient) {
        try {
            let attributes = await rtmClient.getUserAttributesByKeys(memberKey, ['name']);
            if (attributes.name) {
                participantProfiles[memberKey] = attributes.name;
                refreshParticipantsArray();
                return attributes.name;
            }
        } catch (err) {
            console.warn('Could not resolve RTC display name:', memberKey, err);
        }
    }

    return `User ${memberKey}`;
}

let fetchAgoraToken = async (type) => {
    try {
        const response = await fetch(`/token?uid=${encodeURIComponent(uid)}&channel=${encodeURIComponent(roomId)}&type=${encodeURIComponent(type)}`);
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            console.warn(`${type.toUpperCase()} token endpoint returned error:`, data);
            return null;
        }

        if (data.warning) {
            console.warn(`${type.toUpperCase()} token endpoint warning:`, data.warning);
        }

        if (data.tokenless) {
            tokenlessAgoraJoin = true;
        }

        return data.token || null;
    } catch (err) {
        console.warn(`Could not fetch ${type.toUpperCase()} token:`, err);
        return null;
    }
}

let peerSignalUrl = (path = '') => {
    return `/api/rooms/${encodeURIComponent(roomId)}/signals${path}`;
}

let sendPeerSignal = async (to, signalType, payload = null) => {
    const response = await fetch(peerSignalUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            uid: uid,
            displayName: displayName,
            to: to || null,
            signal_type: signalType,
            payload: payload
        })
    });

    if (!response.ok) {
        throw new Error(await response.text());
    }

    return response.json();
}

let createNativeTrackWrapper = (track, ownerUid, muted = false) => {
    return {
        setEnabled: async (enabled) => {
            track.enabled = enabled;
        },
        stop: () => {
            if (track.readyState !== 'ended') {
                track.stop();
            }
        },
        close: () => {
            if (track.readyState !== 'ended') {
                track.stop();
            }
        },
        getMediaStreamTrack: () => track,
        play: (elementId) => {
            let mediaElement;

            if (track.kind === 'video') {
                let target = document.getElementById(elementId);
                if (!target) return;

                target.innerHTML = '';
                mediaElement = document.createElement('video');
                mediaElement.autoplay = true;
                mediaElement.playsInline = true;
                mediaElement.muted = muted;
                target.appendChild(mediaElement);
            } else {
                mediaElement = document.getElementById(`audio-${ownerUid}`);
                if (!mediaElement) {
                    mediaElement = document.createElement('audio');
                    mediaElement.id = `audio-${ownerUid}`;
                    mediaElement.autoplay = true;
                    mediaElement.style.display = 'none';
                    document.body.appendChild(mediaElement);
                }
            }

            mediaElement.srcObject = new MediaStream([track]);
            mediaElement.play().catch((err) => console.warn('Media playback failed:', err));
        }
    };
}

let ensurePeerProfile = (peerUid, name) => {
    if (typeof addMemberProfileToDom === 'function') {
        addMemberProfileToDom(peerUid, name || getParticipantName(peerUid));
    }
}

let shouldInitiatePeerConnection = (peerUid) => {
    return String(uid) > String(peerUid);
}

let ensureLocalTracksOnPeer = (peerConnection) => {
    if (!localPeerStream) return;

    localPeerStream.getTracks().forEach((track) => {
        let alreadyAdded = peerConnection.getSenders().some((sender) => {
            return sender.track && sender.track.id === track.id;
        });

        if (!alreadyAdded) {
            peerConnection.addTrack(track, localPeerStream);
        }
    });
}

let removePeerMedia = (peerUid) => {
    let audioElement = document.getElementById(`audio-${peerUid}`);
    if (audioElement) {
        audioElement.remove();
    }

    delete remoteUsers[peerUid];
    removeVideoContainer(peerUid);
}

let closePeerConnection = (peerUid) => {
    let peerConnection = peerConnections[peerUid];
    if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
        delete peerConnections[peerUid];
    }

    removePeerMedia(peerUid);
}

let handlePeerTrack = async (peerUid, event) => {
    let track = event.track;
    let name = await getDisplayNameForUid(peerUid);
    ensurePeerProfile(peerUid, name);

    if (!remoteUsers[peerUid]) {
        remoteUsers[peerUid] = { uid: peerUid };
    }

    let wrapper = createNativeTrackWrapper(track, peerUid);

    if (track.kind === 'video') {
        remoteUsers[peerUid].videoTrack = wrapper;
        let container = createVideoContainer(peerUid, name, document.getElementById('streams__container'));

        if (displayFrame.style.display && userIdInDisplayFrame !== container.id) {
            container.style.height = '100px';
            container.style.width = '100px';
        }

        let videoContainer = document.getElementById(`user-container-${peerUid}`);
        if (videoContainer) {
            videoContainer.style.backgroundImage = 'none';
        }
        wrapper.play(`user-${peerUid}`);
    }

    if (track.kind === 'audio') {
        remoteUsers[peerUid].audioTrack = wrapper;
        wrapper.play();
    }
}

let createPeerConnection = (peerUid) => {
    if (peerConnections[peerUid]) {
        ensureLocalTracksOnPeer(peerConnections[peerUid]);
        return peerConnections[peerUid];
    }

    let peerConnection = new RTCPeerConnection(peerConnectionConfig);
    peerConnections[peerUid] = peerConnection;
    ensureLocalTracksOnPeer(peerConnection);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendPeerSignal(peerUid, 'candidate', event.candidate.toJSON()).catch((err) => {
                console.warn('Failed to send ICE candidate:', err);
            });
        }
    };

    peerConnection.ontrack = (event) => {
        handlePeerTrack(peerUid, event).catch((err) => console.warn('Failed to handle peer track:', err));
    };

    peerConnection.onconnectionstatechange = () => {
        if (['closed', 'failed'].includes(peerConnection.connectionState)) {
            closePeerConnection(peerUid);
        }
    };

    return peerConnection;
}

let createAndSendPeerOffer = async (peerUid) => {
    let peerConnection = createPeerConnection(peerUid);
    let offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await sendPeerSignal(peerUid, 'offer', peerConnection.localDescription);
}

let connectToAvailablePeers = async () => {
    let peerIds = Object.keys(participantProfiles || {}).filter((peerUid) => peerUid !== uid);

    for (let i = 0; peerIds.length > i; i++) {
        let peerUid = peerIds[i];
        if (shouldInitiatePeerConnection(peerUid)) {
            try {
                await createAndSendPeerOffer(peerUid);
            } catch (err) {
                console.warn('Failed to create peer offer:', peerUid, err);
            }
        }
    }
}

let handlePeerSignal = async (signal) => {
    let peerUid = signal.from;
    if (!peerUid || peerUid === uid) return;

    ensurePeerProfile(peerUid, signal.fromName);

    if (signal.type === 'peer-ready') {
        if (streamJoined && shouldInitiatePeerConnection(peerUid)) {
            await createAndSendPeerOffer(peerUid);
        }
        return;
    }

    if (signal.type === 'peer-left') {
        closePeerConnection(peerUid);
        return;
    }

    if (signal.type === 'offer') {
        let peerConnection = createPeerConnection(peerUid);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
        ensureLocalTracksOnPeer(peerConnection);
        let answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await sendPeerSignal(peerUid, 'answer', peerConnection.localDescription);
        return;
    }

    if (signal.type === 'answer') {
        let peerConnection = peerConnections[peerUid];
        if (peerConnection && peerConnection.signalingState !== 'stable') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.payload));
        }
        return;
    }

    if (signal.type === 'candidate') {
        let peerConnection = createPeerConnection(peerUid);
        if (signal.payload) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(signal.payload));
        }
    }
}

let pollPeerSignals = async () => {
    if (!usingPeerVideoFallback) return;

    try {
        const response = await fetch(peerSignalUrl(`?uid=${encodeURIComponent(uid)}&after=${peerLastSignalId}`));
        if (!response.ok) {
            throw new Error(await response.text());
        }

        const data = await response.json();
        let signals = data.signals || [];

        for (let i = 0; signals.length > i; i++) {
            peerLastSignalId = Math.max(peerLastSignalId, signals[i].id || 0);
            await handlePeerSignal(signals[i]);
        }
    } catch (err) {
        console.warn('Peer signal polling failed:', err);
    }
}

let startPeerVideoFallback = async (reasonMessage = '') => {
    if (peerVideoReady) {
        setJoinButton(true);
        return true;
    }

    if (!window.RTCPeerConnection) {
        addSystemMessageToDom('This browser does not support built-in WebRTC calls.');
        setJoinButton(false, 'Video unavailable');
        return false;
    }

    usingPeerVideoFallback = true;
    peerVideoReady = true;

    if (typeof startFallbackRoomSync === 'function') {
        await startFallbackRoomSync(false);
    }

    setJoinButton(true);
    if (!peerSignalPollTimer) {
        await pollPeerSignals();
        peerSignalPollTimer = setInterval(pollPeerSignals, 1000);
    }

    return true;
}

let joinPeerStream = async () => {
    let mediaSetupError = getMediaSetupErrorMessage();
    if (mediaSetupError) {
        addSystemMessageToDom(mediaSetupError);
        return;
    }

    setJoinButton(false, 'Opening camera...');

    try {
        localPeerStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });

        let audioTrack = localPeerStream.getAudioTracks()[0];
        let videoTrack = localPeerStream.getVideoTracks()[0];

        if (!audioTrack || !videoTrack) {
            throw new Error('Camera and microphone tracks are required.');
        }

        localTracks = [
            createNativeTrackWrapper(audioTrack, uid, true),
            createNativeTrackWrapper(videoTrack, uid, true)
        ];

        createLocalVideoContainer();
        localTracks[1].play(`user-${uid}`);

        streamJoined = true;
        audioMuted = false;
        cameraMuted = false;
        micButton.classList.add('active');
        cameraButton.classList.add('active');
        setLocalVideoAvatar(false);

        joinButton.style.display = 'none';
        setStreamActionsVisible(true);

        await sendPeerSignal(null, 'peer-ready', {});
        await connectToAvailablePeers();
    } catch (err) {
        console.error('Join peer stream error:', err);
        closeTracks(localTracks);
        if (localPeerStream) {
            localPeerStream.getTracks().forEach((track) => track.stop());
        }
        localTracks = [];
        localPeerStream = null;
        removeVideoContainer(uid);
        addSystemMessageToDom(getCameraErrorMessage(err));
        joinButton.style.display = 'block';
        setJoinButton(true);
    }
}

let leavePeerStream = async () => {
    if (isRecording) {
        await stopRecording();
    }

    try {
        await sendPeerSignal(null, 'peer-left', {});
    } catch (err) {
        console.warn('Could not notify peers about leaving stream:', err);
    }

    Object.keys(peerConnections).forEach(closePeerConnection);
    closeTracks(localTracks);

    if (localPeerStream) {
        localPeerStream.getTracks().forEach((track) => track.stop());
    }

    localTracks = [];
    localPeerStream = null;
    remoteUsers = {};
    streamJoined = false;
    sharingScreen = false;
    audioMuted = false;
    cameraMuted = false;

    removeVideoContainer(uid);

    screenButton.classList.remove('active');
    cameraButton.classList.add('active');
    cameraButton.style.display = '';
    micButton.classList.add('active');

    setStreamActionsVisible(false);
    joinButton.style.display = 'block';
    setJoinButton(true);
}

let initRtc = async () => {
    try {
        client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        client.on('user-published', handleUserPublished);
        client.on('user-unpublished', handleUserUnpublished);
        client.on('user-left', handleUserLeft);

        let rtcToken = await fetchAgoraToken('rtc');
        await client.join(APP_ID, roomId, rtcToken, uid);
        rtcJoined = true;
        setJoinButton(true);
        return true;
    } catch (err) {
        console.error('RTC join/init error:', err);
        await startPeerVideoFallback(getAgoraConnectionErrorMessage(err));
        return false;
    }
}

let initRtm = async () => {
    try {
        let rtmToken = await fetchAgoraToken('rtm');
        rtmClient = await AgoraRTM.createInstance(APP_ID);
        await rtmClient.login({ uid, token: rtmToken });
        await rtmClient.addOrUpdateLocalUserAttributes({ name: displayName });

        channel = await rtmClient.createChannel(roomId);
        channel.on('MemberJoined', handleMemberJoined);
        channel.on('MemberLeft', handleMemberLeft);
        channel.on('ChannelMessage', handleChannelMessage);
        await channel.join();

        await getMembers();
        addSystemMessageToDom(`Welcome to the room ${displayName}!`);
        return true;
    } catch (err) {
        console.error('RTM join/init error:', err);
        addSystemMessageToDom('Agora chat could not connect. Trying the server fallback now.');
        if (typeof startFallbackRoomSync === 'function') {
            await startFallbackRoomSync();
        }
        return false;
    }
}

let joinRoomInit = async () => {
    setJoinButton(false, 'Connecting...');

    if (!hasAgoraAppId()) {
        await startPeerVideoFallback('Agora App ID is missing.');
        return;
    }

    let mediaSetupError = getMediaSetupErrorMessage();
    if (mediaSetupError) {
        addSystemMessageToDom(mediaSetupError);
    }

    await initRtm();
    await initRtc();
}

let joinStream = async () => {
    if (streamJoined) return;

    if (usingPeerVideoFallback) {
        await joinPeerStream();
        return;
    }

    if (!rtcJoined || !client) {
        addSystemMessageToDom('Video is still connecting. Please try again in a moment.');
        return;
    }

    let mediaSetupError = getMediaSetupErrorMessage();
    if (mediaSetupError) {
        addSystemMessageToDom(mediaSetupError);
        return;
    }

    setJoinButton(false, 'Opening camera...');

    try {
        localTracks = await AgoraRTC.createMicrophoneAndCameraTracks({}, {
            encoderConfig: {
                width: { min: 640, ideal: 1280, max: 1920 },
                height: { min: 480, ideal: 720, max: 1080 }
            }
        });

        createLocalVideoContainer();
        localTracks[1].play(`user-${uid}`);
        await client.publish([localTracks[0], localTracks[1]]);

        streamJoined = true;
        audioMuted = false;
        cameraMuted = false;
        micButton.classList.add('active');
        cameraButton.classList.add('active');
        setLocalVideoAvatar(false);

        joinButton.style.display = 'none';
        setStreamActionsVisible(true);
    } catch (err) {
        console.error('Join stream error:', err);
        closeTracks(localTracks);
        localTracks = [];
        removeVideoContainer(uid);
        addSystemMessageToDom(getCameraErrorMessage(err));
        joinButton.style.display = 'block';
        setJoinButton(true);
    }
}

let switchToCamera = async () => {
    if (usingPeerVideoFallback) {
        createLocalVideoContainer(document.getElementById('streams__container'));
        if (localTracks[1]) {
            localTracks[1].play(`user-${uid}`);
            await setTrackEnabled(localTracks[1], !cameraMuted);
            setLocalVideoAvatar(cameraMuted);
        }
        resetVideoFrames();
        return;
    }

    removeVideoContainer(uid);
    displayFrame.style.display = null;
    userIdInDisplayFrame = null;

    createLocalVideoContainer(document.getElementById('streams__container'));

    if (localTracks[1]) {
        localTracks[1].play(`user-${uid}`);
        await setTrackEnabled(localTracks[1], !cameraMuted);
        setLocalVideoAvatar(cameraMuted);
        await client.publish([localTracks[1]]);
    }

    resetVideoFrames();
}

let handleUserPublished = async (user, mediaType) => {
    remoteUsers[user.uid] = user;

    try {
        await client.subscribe(user, mediaType);
    } catch (err) {
        console.error('Subscribe error:', err);
        return;
    }

    if (mediaType === 'video') {
        let name = await getDisplayNameForUid(user.uid);
        let container = createVideoContainer(user.uid, name, document.getElementById('streams__container'));

        if (displayFrame.style.display && userIdInDisplayFrame !== container.id) {
            container.style.height = '100px';
            container.style.width = '100px';
        }

        user.videoTrack.play(`user-${user.uid}`);
    }

    if (mediaType === 'audio') {
        user.audioTrack.play();
    }
}

let handleUserUnpublished = async (user, mediaType) => {
    if (mediaType === 'video') {
        removeVideoContainer(user.uid);
    }
}

let handleUserLeft = async (user) => {
    delete remoteUsers[user.uid];
    removeVideoContainer(user.uid);
}

let toggleMic = async (e) => {
    let button = e.currentTarget;
    const audioTrack = localTracks && localTracks[0];

    if (!streamJoined || !audioTrack) {
        addSystemMessageToDom('Join the stream before using the microphone button.');
        return;
    }

    try {
        let shouldEnable = audioMuted;
        await setTrackEnabled(audioTrack, shouldEnable);
        audioMuted = !shouldEnable;
        button.classList.toggle('active', shouldEnable);
    } catch (err) {
        console.error('toggleMic error:', err);
    }
}

let toggleCamera = async (e) => {
    let button = e.currentTarget;
    const videoTrack = localTracks && localTracks[1];

    if (!streamJoined || !videoTrack) {
        addSystemMessageToDom('Join the stream before using the camera button.');
        return;
    }

    if (sharingScreen) {
        addSystemMessageToDom('Stop screen sharing before changing the camera.');
        return;
    }

    try {
        let shouldEnable = cameraMuted;
        await setTrackEnabled(videoTrack, shouldEnable);
        cameraMuted = !shouldEnable;
        button.classList.toggle('active', shouldEnable);
        setLocalVideoAvatar(cameraMuted);
    } catch (err) {
        console.error('toggleCamera error:', err);
    }
}

let startScreenShare = async () => {
    let screenTracks;
    let cameraWasUnpublished = false;

    try {
        screenTracks = await AgoraRTC.createScreenVideoTrack({
            encoderConfig: '1080p_1'
        });
        localScreenTracks = screenTracks;

        await client.unpublish([localTracks[1]]);
        cameraWasUnpublished = true;
        removeVideoContainer(uid);

        displayFrame.style.display = 'block';
        userIdInDisplayFrame = `user-container-${uid}`;
        createLocalVideoContainer(displayFrame);

        let screenTrackList = getTrackList(localScreenTracks);
        screenTrackList[0].play(`user-${uid}`);
        await client.publish(screenTrackList);

        sharingScreen = true;
        screenButton.classList.add('active');
        cameraButton.classList.remove('active');
        cameraButton.style.display = 'none';

        if (screenTrackList[0] && typeof screenTrackList[0].on === 'function') {
            screenTrackList[0].on('track-ended', () => {
                if (sharingScreen) {
                    stopScreenShare();
                }
            });
        }
    } catch (err) {
        console.error('Screen share error:', err);
        closeTracks(screenTracks);
        localScreenTracks = null;
        sharingScreen = false;
        screenButton.classList.remove('active');
        cameraButton.style.display = '';
        if (cameraWasUnpublished) {
            await switchToCamera();
        }
        addSystemMessageToDom('Screen sharing could not start. Please allow screen sharing and try again.');
    }
}

let stopScreenShare = async () => {
    let screenTrackList = getTrackList(localScreenTracks);

    try {
        if (screenTrackList.length) {
            await client.unpublish(screenTrackList);
        }
    } catch (err) {
        console.warn('Could not unpublish screen share:', err);
    }

    closeTracks(screenTrackList);
    localScreenTracks = null;
    sharingScreen = false;
    screenButton.classList.remove('active');
    cameraButton.style.display = '';
    cameraButton.classList.toggle('active', !cameraMuted);

    await switchToCamera();
}

let toggleScreen = async () => {
    if (usingPeerVideoFallback) {
        addSystemMessageToDom('Screen sharing is unavailable while using the built-in video fallback.');
        return;
    }

    if (!streamJoined || !client || !localTracks[1]) {
        addSystemMessageToDom('Join the stream before sharing your screen.');
        return;
    }

    if (sharingScreen) {
        await stopScreenShare();
    } else {
        await startScreenShare();
    }
}

let isRecording = false;
let recordingCanvas = null;
let recordingContext = null;
let recordingAnimationFrame = null;
let recordingStream = null;
let recordingAudioContext = null;
let recordingAudioSources = [];
let recordingStopPromise = null;
let resolveRecordingStop = null;

let getSupportedRecordingMimeType = () => {
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') {
        return '';
    }

    const mimeTypes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp8',
        'video/webm'
    ];

    return mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || '';
}

let getMediaTrack = (trackWrapper) => {
    if (!trackWrapper) return null;

    if (typeof trackWrapper.getMediaStreamTrack === 'function') {
        return trackWrapper.getMediaStreamTrack();
    }

    return trackWrapper.kind ? trackWrapper : null;
}

let getRecordingAudioTracks = () => {
    let tracks = [];

    if (localTracks[0]) {
        tracks.push(getMediaTrack(localTracks[0]));
    }

    for (let userId in remoteUsers) {
        const user = remoteUsers[userId];
        if (user.audioTrack) {
            tracks.push(getMediaTrack(user.audioTrack));
        }
    }

    return tracks.filter((track, index, allTracks) => {
        return track && track.kind === 'audio' && track.readyState === 'live' && allTracks.indexOf(track) === index;
    });
}

let drawRoundedRect = (context, x, y, width, height, radius) => {
    let safeRadius = Math.min(radius, width / 2, height / 2);

    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.lineTo(x + width - safeRadius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
    context.lineTo(x + width, y + height - safeRadius);
    context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
    context.lineTo(x + safeRadius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
    context.lineTo(x, y + safeRadius);
    context.quadraticCurveTo(x, y, x + safeRadius, y);
    context.closePath();
}

let drawVideoCover = (context, video, x, y, width, height) => {
    let videoWidth = video.videoWidth || width;
    let videoHeight = video.videoHeight || height;
    let scale = Math.max(width / videoWidth, height / videoHeight);
    let drawWidth = videoWidth * scale;
    let drawHeight = videoHeight * scale;
    let drawX = x + (width - drawWidth) / 2;
    let drawY = y + (height - drawHeight) / 2;

    context.drawImage(video, drawX, drawY, drawWidth, drawHeight);
}

let getRecordingTiles = () => {
    let containers = Array.from(document.querySelectorAll('#stream__box .video__container, #streams__container .video__container'));
    let seen = {};

    return containers.filter((container) => {
        if (!container || seen[container.id]) return false;
        seen[container.id] = true;
        return container.offsetWidth > 0 && container.offsetHeight > 0;
    });
}

let drawRecordingFrame = () => {
    if (!recordingContext || !recordingCanvas) return;

    let context = recordingContext;
    let width = recordingCanvas.width;
    let height = recordingCanvas.height;
    let tiles = getRecordingTiles();
    let tileCount = Math.max(tiles.length, 1);
    let columns = Math.ceil(Math.sqrt(tileCount));
    let rows = Math.ceil(tileCount / columns);
    let padding = 24;
    let gap = 14;
    let cellWidth = (width - (padding * 2) - (gap * (columns - 1))) / columns;
    let cellHeight = (height - (padding * 2) - (gap * (rows - 1))) / rows;

    context.fillStyle = '#111111';
    context.fillRect(0, 0, width, height);

    for (let i = 0; i < tiles.length; i++) {
        let tile = tiles[i];
        let column = i % columns;
        let row = Math.floor(i / columns);
        let x = padding + column * (cellWidth + gap);
        let y = padding + row * (cellHeight + gap);
        let video = tile.querySelector('video');
        let userUid = tile.id.replace('user-container-', '');
        let name = userUid === uid ? displayName : getParticipantName(userUid);

        context.save();
        drawRoundedRect(context, x, y, cellWidth, cellHeight, 18);
        context.clip();
        context.fillStyle = '#262625';
        context.fillRect(x, y, cellWidth, cellHeight);

        if (video && video.readyState >= 2 && video.offsetWidth > 0 && video.offsetHeight > 0) {
            try {
                drawVideoCover(context, video, x, y, cellWidth, cellHeight);
            } catch (err) {
                console.warn('Could not draw video tile:', err);
            }
        } else {
            context.fillStyle = '#845695';
            context.beginPath();
            context.arc(x + cellWidth / 2, y + cellHeight / 2, Math.min(cellWidth, cellHeight) * 0.18, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = '#ffffff';
            context.font = '600 42px Poppins, sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText((name || 'G').trim().charAt(0).toUpperCase(), x + cellWidth / 2, y + cellHeight / 2);
        }

        context.restore();

        context.fillStyle = 'rgba(0, 0, 0, 0.55)';
        context.fillRect(x, y + cellHeight - 42, cellWidth, 42);
        context.fillStyle = '#ffffff';
        context.font = '500 22px Poppins, sans-serif';
        context.textAlign = 'left';
        context.textBaseline = 'middle';
        context.fillText(name || 'Guest', x + 16, y + cellHeight - 21, cellWidth - 32);
    }

    if (!tiles.length) {
        context.fillStyle = '#ffffff';
        context.font = '600 32px Poppins, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText('Recording meeting...', width / 2, height / 2);
    }

    recordingAnimationFrame = requestAnimationFrame(drawRecordingFrame);
}

let createRecordingStream = async () => {
    recordingCanvas = document.createElement('canvas');
    recordingCanvas.width = 1280;
    recordingCanvas.height = 720;
    recordingContext = recordingCanvas.getContext('2d');

    if (!recordingContext || typeof recordingCanvas.captureStream !== 'function') {
        throw new Error('Canvas recording is not supported by this browser.');
    }

    drawRecordingFrame();

    let canvasStream = recordingCanvas.captureStream(30);
    let mixedStream = new MediaStream(canvasStream.getVideoTracks());
    let audioTracks = getRecordingAudioTracks();

    if (audioTracks.length && (window.AudioContext || window.webkitAudioContext)) {
        recordingAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        await recordingAudioContext.resume();
        let audioDestination = recordingAudioContext.createMediaStreamDestination();

        audioTracks.forEach((track) => {
            let source = recordingAudioContext.createMediaStreamSource(new MediaStream([track]));
            source.connect(audioDestination);
            recordingAudioSources.push(source);
        });

        audioDestination.stream.getAudioTracks().forEach((track) => mixedStream.addTrack(track));
    }

    return mixedStream;
}

let cleanupRecordingCapture = async () => {
    if (recordingAnimationFrame) {
        cancelAnimationFrame(recordingAnimationFrame);
    }

    recordingAnimationFrame = null;
    recordingCanvas = null;
    recordingContext = null;
    recordingAudioSources = [];

    if (recordingStream) {
        recordingStream.getTracks().forEach((track) => track.stop());
    }
    recordingStream = null;

    if (recordingAudioContext) {
        try {
            await recordingAudioContext.close();
        } catch (err) {
            console.warn('Could not close recording audio context:', err);
        }
    }
    recordingAudioContext = null;
}

let downloadRecording = (blob, filename) => {
    let url = URL.createObjectURL(blob);
    let link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

let uploadRecordingToDrive = async (blob, filename) => {
    const formData = new FormData();
    formData.append('file', blob, filename);

    const response = await fetch('/upload-video', {
        method: 'POST',
        body: formData
    });
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok || !contentType.includes('application/json')) {
        return null;
    }

    const result = await response.json();
    return result.file_path || null;
}

async function startRecording() {
    if (!streamJoined || !localTracks[0] || !localTracks[1]) {
        addSystemMessageToDom('Join the stream before recording.');
        return;
    }

    if (!window.MediaRecorder) {
        addSystemMessageToDom('Recording is not supported by this browser.');
        return;
    }

    chunks = [];

    try {
        recordingStream = await createRecordingStream();
        let mimeType = getSupportedRecordingMimeType();
        mediaRecorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    } catch (err) {
        console.error('Recording error:', err);
        await cleanupRecordingCapture();
        addSystemMessageToDom('Recording is not supported by this browser or stream.');
        return;
    }

    mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
            chunks.push(event.data);
        }
    };

    recordingStopPromise = new Promise((resolve) => {
        resolveRecordingStop = resolve;
        mediaRecorder.onstop = async () => {
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'video/webm' });
            const currentDate = new Date().toISOString().split('T')[0];
            const filename = `recording-${currentDate}.webm`;

            await cleanupRecordingCapture();

            if (!blob.size) {
                addSystemMessageToDom('Recording stopped, but no video data was created.');
                resolve();
                resolveRecordingStop = null;
                return;
            }

            downloadRecording(blob, filename);
            addSystemMessageToDom('Recording saved to your downloads.');

            try {
                localVideoFilePath = await uploadRecordingToDrive(blob, filename);
                if (localVideoFilePath) {
                    await saveSessionData();
                    addSystemMessageToDom('Recording also uploaded to Google Drive.');
                } else {
                    addSystemMessageToDom('Log in with Google to also upload recordings to Drive.');
                }
            } catch (error) {
                console.error('Error uploading video:', error);
                addSystemMessageToDom('Recording saved locally. Google Drive upload failed.');
            }

            resolve();
            resolveRecordingStop = null;
        };
    });

    mediaRecorder.onerror = async (event) => {
        console.error('Recording error:', event.error || event);
        await cleanupRecordingCapture();
        recordButton.classList.remove('active');
        isRecording = false;
        if (resolveRecordingStop) {
            resolveRecordingStop();
        }
        resolveRecordingStop = null;
        recordingStopPromise = null;
        addSystemMessageToDom('Recording failed. Please try again.');
    };

    mediaRecorder.start(1000);
    recordButton.classList.add('active');
    isRecording = true;
    addSystemMessageToDom('Recording started.');
}

async function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        if (recordingStopPromise) {
            await recordingStopPromise;
        }
    } else {
        await cleanupRecordingCapture();
    }

    recordButton.classList.remove('active');
    isRecording = false;
    recordingStopPromise = null;
    resolveRecordingStop = null;
}

let toggleRecording = async () => {
    if (isRecording) {
        await stopRecording();
    } else {
        await startRecording();
    }
}

let saveSessionData = async () => {
    try {
        const response = await fetch('/record-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                channel_name: inviteId,
                video_link: localVideoFilePath,
                participants: JSON.stringify(participants),
                messages: JSON.stringify(messages)
            })
        });
        const result = await response.json();
        console.log('Session recorded successfully:', result.message);
    } catch (error) {
        console.error('Error saving session data:', error);
    }
};

let leaveStream = async (e) => {
    e.preventDefault();

    if (!streamJoined) {
        return;
    }

    if (usingPeerVideoFallback) {
        await leavePeerStream();
        return;
    }

    if (isRecording) {
        await stopRecording();
    }

    let screenTrackList = getTrackList(localScreenTracks);
    let tracksToUnpublish = [localTracks[0]];
    if (!sharingScreen) {
        tracksToUnpublish.push(localTracks[1]);
    }
    tracksToUnpublish.push(...screenTrackList);
    tracksToUnpublish = tracksToUnpublish.filter(Boolean);

    try {
        if (tracksToUnpublish.length) {
            await client.unpublish(tracksToUnpublish);
        }
    } catch (err) {
        console.warn('Could not unpublish local tracks:', err);
    }

    closeTracks(screenTrackList);
    closeTracks(localTracks);
    localTracks = [];
    localScreenTracks = null;
    streamJoined = false;
    sharingScreen = false;
    audioMuted = false;
    cameraMuted = false;

    removeVideoContainer(uid);

    screenButton.classList.remove('active');
    cameraButton.classList.add('active');
    cameraButton.style.display = '';
    micButton.classList.add('active');

    setStreamActionsVisible(false);
    joinButton.style.display = 'block';
    setJoinButton(true);

    try {
        if (channel) {
            await channel.sendMessage({ text: JSON.stringify({ type: 'user_left', uid: uid }) });
        }
    } catch (err) {
        console.warn('Could not notify channel about leaving stream:', err);
    }
}

cameraButton.addEventListener('click', toggleCamera);
micButton.addEventListener('click', toggleMic);
screenButton.addEventListener('click', toggleScreen);
joinButton.addEventListener('click', joinStream);
leaveButton.addEventListener('click', leaveStream);
recordButton.addEventListener('click', toggleRecording);

window.addEventListener('beforeunload', () => {
    if (usingPeerVideoFallback && streamJoined) {
        try {
            fetch(peerSignalUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uid: uid,
                    displayName: displayName,
                    signal_type: 'peer-left',
                    payload: {}
                }),
                keepalive: true
            });
        } catch (err) {
            console.warn('Peer leave signal failed:', err);
        }
    }
});

document.addEventListener('DOMContentLoaded', function() {
    var dropdown = document.getElementById('myDropdown');
    var button = document.getElementById('dropbtn');

    button.addEventListener('click', function() {
        dropdown.classList.toggle('show');
        button.classList.toggle('active');
    });

    window.addEventListener('click', function(event) {
        if (!event.target.closest('.dropbtn') && !event.target.closest('.dropdown-content')) {
            dropdown.classList.remove('show');
            button.classList.remove('active');
        }
    });
});

joinRoomInit();
