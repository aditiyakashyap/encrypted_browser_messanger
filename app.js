// Global State & Core Properties
let myId = "";
let idVisible = false;
let signalingBroker = null;
let activePeerConnection = null;
let activeDataChannel = null;
let currentChatPeerId = null;

// Local Memory Repositories
let activeChats = []; 
let cachedOffers = {}; // Stores pending requests

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- Initialization ---
window.addEventListener('DOMContentLoaded', () => {
    generateUserIdentity();
    initializeSignalingSystem();
    updateSidebarUI();
});

function generateUserIdentity() {
    let savedId = localStorage.getItem('ghost_my_id');
    if (!savedId) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let segment = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        savedId = `${segment()}-${segment()}-${segment()}`;
        localStorage.setItem('ghost_my_id', savedId);
    }
    myId = savedId;
}

function toggleIDVisibility() {
    const idSpan = document.getElementById('my-unique-id');
    idVisible = !idVisible;
    if (idVisible) {
        idSpan.innerText = myId;
        idSpan.classList.remove('censored');
        navigator.clipboard.writeText(myId);
        // Briefly show it, then hide it again
        setTimeout(() => {
            idVisible = false;
            idSpan.innerText = "***-***-***";
            idSpan.classList.add('censored');
        }, 3000);
    }
}

// --- MQTT Signaling ---
function initializeSignalingSystem() {
    signalingBroker = mqtt.connect('wss://broker.emqx.io:8084/mqtt');
    signalingBroker.on('connect', () => {
        signalingBroker.subscribe(`ghoststream/signal/${myId}`);
    });

    signalingBroker.on('message', async (topic, payload) => {
        const signalData = JSON.parse(payload.toString());
        
        if (signalData.type === 'offer') {
            // Received an incoming request
            cachedOffers[signalData.sender] = signalData.sdp;
            updateSidebarUI(); // Triggers the chat list to show the pending request
        } else if (signalData.type === 'answer') {
            if (activePeerConnection) {
                await activePeerConnection.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
            }
        } else if (signalData.type === 'deny') {
            alert("The connection request was denied.");
            resetCommunicationEngine();
        }
    });
}

// --- Outbound Flow (Alice -> Bob) ---
async function requestPeerConnection() {
    const peerId = document.getElementById('connect-peer-id').value.trim();
    if (!peerId || peerId === myId) return alert("Invalid Peer ID.");

    closeNewChatModal();
    currentChatPeerId = peerId;
    setupWebRTCEngine(peerId);

    activeDataChannel = activePeerConnection.createDataChannel("chat-stream");
    bindDataChannelEvents(activeDataChannel);

    const offer = await activePeerConnection.createOffer();
    await activePeerConnection.setLocalDescription(offer);

    signalingBroker.publish(`ghoststream/signal/${peerId}`, JSON.stringify({
        type: 'offer',
        sender: myId,
        sdp: offer
    }));

    trackActiveChatSession(peerId);
    openActiveChatView(peerId, "Connecting...");
}

// --- UI Sidebar Logic (WhatsApp Flow) ---
function updateSidebarUI() {
    const promptBox = document.getElementById('empty-state-prompt');
    const chatList = document.getElementById('chat-list');
    const fab = document.getElementById('fab-new-chat');

    const hasChats = activeChats.length > 0 || Object.keys(cachedOffers).length > 0;

    if (!hasChats) {
        promptBox.classList.remove('hidden');
        chatList.classList.add('hidden');
        fab.classList.add('hidden');
    } else {
        promptBox.classList.add('hidden');
        chatList.classList.remove('hidden');
        fab.classList.remove('hidden');
        renderChatList();
    }
}

function renderChatList() {
    const list = document.getElementById('chat-list');
    list.innerHTML = '';

    // 1. Render Pending Requests first
    Object.keys(cachedOffers).forEach(senderId => {
        const li = document.createElement('li');
        li.className = 'chat-item pending';
        li.innerHTML = `
            <div class="avatar" style="background-color: #f59e0b;">?</div>
            <div class="details">
                <span class="title">${senderId}</span>
                <span class="subtitle">Incoming connection request</span>
            </div>
        `;
        li.onclick = () => openPendingRequestView(senderId);
        list.appendChild(li);
    });

    // 2. Render Active Chats
    activeChats.forEach(id => {
        const li = document.createElement('li');
        li.className = 'chat-item';
        li.innerHTML = `
            <div class="avatar" style="background-color: #6366f1;">${id.charAt(0)}</div>
            <div class="details">
                <span class="title">${id}</span>
                <span class="subtitle">Tap to chat</span>
            </div>
        `;
        li.onclick = () => {
            if (currentChatPeerId !== id) {
                alert("Reconnect required to switch encrypted context.");
            }
        };
        list.appendChild(li);
    });
}

function trackActiveChatSession(id) {
    if (!activeChats.includes(id)) {
        activeChats.push(id);
        updateSidebarUI();
    }
}

// --- View Switching (Right Pane) ---
function switchView(viewId) {
    document.querySelectorAll('.view-pane').forEach(el => el.classList.remove('active-view'));
    document.getElementById(viewId).classList.add('active-view');
}

function openPendingRequestView(senderId) {
    currentChatPeerId = senderId;
    document.getElementById('pending-peer-id').innerText = senderId;
    switchView('view-pending');
}

function openActiveChatView(peerId, status) {
    document.getElementById('current-chat-name').innerText = peerId;
    document.getElementById('current-chat-status').innerText = status;
    document.getElementById('messages-window').innerHTML = ''; // clear previous
    switchView('view-chat');
}

// --- Inbound Action Handlers ---
function handleDeny() {
    if(!currentChatPeerId) return;
    signalingBroker.publish(`ghoststream/signal/${currentChatPeerId}`, JSON.stringify({
        type: 'deny',
        sender: myId
    }));
    delete cachedOffers[currentChatPeerId];
    currentChatPeerId = null;
    updateSidebarUI();
    switchView('view-blank');
}

async function handleAllow() {
    const senderId = currentChatPeerId;
    setupWebRTCEngine(senderId);

    activePeerConnection.ondatachannel = (event) => {
        activeDataChannel = event.channel;
        bindDataChannelEvents(activeDataChannel);
    };

    const offerSDP = cachedOffers[senderId];
    await activePeerConnection.setRemoteDescription(new RTCSessionDescription(offerSDP));
    
    const answer = await activePeerConnection.createAnswer();
    await activePeerConnection.setLocalDescription(answer);

    signalingBroker.publish(`ghoststream/signal/${senderId}`, JSON.stringify({
        type: 'answer',
        sender: myId,
        sdp: answer
    }));

    delete cachedOffers[senderId];
    trackActiveChatSession(senderId);
    openActiveChatView(senderId, "Secure Link Established");
}

// --- WebRTC Logic ---
function setupWebRTCEngine(peerId) {
    activePeerConnection = new RTCPeerConnection(rtcConfig);
    activePeerConnection.onicecandidate = (e) => { /* handled internally */ };
    activePeerConnection.onconnectionstatechange = () => {
        if (activePeerConnection.connectionState === 'connected') {
            document.getElementById('current-chat-status').innerText = 'Online';
        } else if (['failed', 'closed', 'disconnected'].includes(activePeerConnection.connectionState)) {
            document.getElementById('current-chat-status').innerText = 'Disconnected';
        }
    };
}

function bindDataChannelEvents(channel) {
    channel.onmessage = (event) => {
        const data = JSON.parse(event.data);
        renderBubble(data.text, 'received');
    };
}

function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const msgText = input.value.trim();
    if (!msgText || !activeDataChannel || activeDataChannel.readyState !== 'open') return;

    activeDataChannel.send(JSON.stringify({ text: msgText }));
    renderBubble(msgText, 'sent');
    input.value = '';
}

function renderBubble(text, direction) {
    const window = document.getElementById('messages-window');
    const bubble = document.createElement('div');
    bubble.className = `bubble ${direction}`;
    bubble.innerText = text;
    window.appendChild(bubble);
    window.scrollTop = window.scrollHeight;
}

function resetCommunicationEngine() {
    if (activePeerConnection) activePeerConnection.close();
    activePeerConnection = null;
    activeDataChannel = null;
    currentChatPeerId = null;
    switchView('view-blank');
}

// --- Modals ---
function openNewChatModal() { document.getElementById('new-chat-modal').classList.remove('hidden'); }
function closeNewChatModal() { document.getElementById('new-chat-modal').classList.add('hidden'); }
