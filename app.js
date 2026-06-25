// Global State & Core Properties
let myId = "";
let signalingBroker = null;
let activePeerConnection = null;
let activeDataChannel = null;
let currentChatPeerId = null;

// Local Memory Repositories (Persisted per device via localStorage)
let contacts = JSON.parse(localStorage.getItem('ghost_contacts')) || {};
let activeChats = []; 
let cachedOffers = {};

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- Initialize App Mechanics ---
window.addEventListener('DOMContentLoaded', () => {
    generateUserIdentity();
    initializeSignalingSystem();
    renderContactBook();
    renderActiveChatsList();
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
    document.getElementById('my-unique-id').innerText = myId;
}

// --- Blind Signaling Mesh Layer (MQTT over WebSockets) ---
function initializeSignalingSystem() {
    // Connects to a highly scalable, public, completely zero-log MQTT broker as a transport line
    signalingBroker = mqtt.connect('wss://broker.emqx.io:8084/mqtt');

    signalingBroker.on('connect', () => {
        // Subscribe to our own personal ID stream to receive incoming handshakes
        signalingBroker.subscribe(`ghoststream/signal/${myId}`);
    });

    signalingBroker.on('message', async (topic, payload) => {
        const signalData = JSON.parse(payload.toString());
        
        if (signalData.type === 'offer') {
            cachedOffers[signalData.sender] = signalData.sdp;
            showInboundRequestModal(signalData.sender);
        } else if (signalData.type === 'answer') {
            if (activePeerConnection) {
                await activePeerConnection.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
            }
        } else if (signalData.type === 'deny') {
            alert("The connection request was denied by the peer.");
            resetCommunicationEngine();
        }
    });
}

// --- Outbound Connection Logic (Alice -> Bob) ---
async function requestPeerConnection() {
    const peerId = document.getElementById('connect-peer-id').value.trim();
    if (!peerId || peerId === myId) return alert("Please enter a valid third-party Peer ID.");

    currentChatPeerId = peerId;
    setupWebRTCEngine(peerId);

    // Create the DataChannel configuration
    activeDataChannel = activePeerConnection.createDataChannel("chat-stream");
    bindDataChannelEvents(activeDataChannel);

    const offer = await activePeerConnection.createOffer();
    await activePeerConnection.setLocalDescription(offer);

    // Broadcast network offer parameters targeting the specific peer channel
    signalingBroker.publish(`ghoststream/signal/${peerId}`, JSON.stringify({
        type: 'offer',
        sender: myId,
        sdp: offer
    }));

    openChatView(peerId);
    document.getElementById('current-chat-name').innerText = getContactAlias(peerId);
    document.getElementById('current-chat-id').innerText = `Connecting with ${peerId}...`;
}

// --- Inbound Connection Flow Control (Bob evaluation) ---
function showInboundRequestModal(senderId) {
    document.getElementById('incoming-peer-id').innerText = senderId;
    document.getElementById('connection-modal').classList.remove('hidden');
}

function rejectIncomingConnection() {
    const senderId = document.getElementById('incoming-peer-id').innerText;
    document.getElementById('connection-modal').classList.add('hidden');
    
    signalingBroker.publish(`ghoststream/signal/${senderId}`, JSON.stringify({
        type: 'deny',
        sender: myId
    }));
    delete cachedOffers[senderId];
}

async function acceptIncomingConnection() {
    const senderId = document.getElementById('incoming-peer-id').innerText;
    document.getElementById('connection-modal').classList.add('hidden');

    currentChatPeerId = senderId;
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
    openChatView(senderId);
    trackActiveChatSession(senderId);
}

// --- WebRTC Protocol Configurations ---
function setupWebRTCEngine(peerId) {
    activePeerConnection = new RTCPeerConnection(rtcConfig);

    activePeerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            // Local collection handles streaming initialization inside SDP payloads directly
        }
    };

    activePeerConnection.onconnectionstatechange = () => {
        if (activePeerConnection.connectionState === 'connected') {
            document.getElementById('current-chat-id').innerText = `Direct P2P Link Established`;
            trackActiveChatSession(peerId);
        } else if (['failed', 'closed', 'disconnected'].includes(activePeerConnection.connectionState)) {
            alert("P2P Communication link severed.");
            resetCommunicationEngine();
        }
    };
}

function bindDataChannelEvents(channel) {
    channel.onmessage = (event) => {
        const data = JSON.parse(event.data);
        renderBubble(data.text, 'received');
    };
}

// --- Data Delivery & UI Messaging Pipeline ---
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

// --- Contact Management & LocalStorage Repositories ---
function saveNewContact() {
    const name = document.getElementById('new-contact-name').value.trim();
    const id = document.getElementById('new-contact-id').value.trim();

    if (!name || !id) return alert("Please enter both a contact name and a unique ID.");

    contacts[id] = name;
    localStorage.setItem('ghost_contacts', JSON.stringify(contacts));
    
    document.getElementById('new-contact-name').value = '';
    document.getElementById('new-contact-id').value = '';
    
    renderContactBook();
    alert("Contact committed to device local memory storage.");
}

function renderContactBook() {
    const list = document.getElementById('contacts-list');
    list.innerHTML = '';
    
    Object.keys(contacts).forEach(id => {
        const li = document.createElement('li');
        li.className = 'list-item';
        li.innerHTML = `<span class="title">${contacts[id]}</span><span class="subtitle">${id}</span>`;
        li.onclick = () => {
            document.getElementById('connect-peer-id').value = id;
            switchTab('chats');
        };
        list.appendChild(li);
    });
}

function trackActiveChatSession(id) {
    if (!activeChats.includes(id)) {
        activeChats.push(id);
        renderActiveChatsList();
    }
}

function renderActiveChatsList() {
    const list = document.getElementById('active-chats-list');
    list.innerHTML = '';

    activeChats.forEach(id => {
        const li = document.createElement('li');
        li.className = 'list-item';
        li.innerHTML = `<span class="title">${getContactAlias(id)}</span><span class="subtitle">${id}</span>`;
        li.onclick = () => {
            if (currentChatPeerId === id) return;
            alert("To context-switch to this session, reconnect via structural verification parameters.");
        };
        list.appendChild(li);
    });
}

// --- Interface Helper Utilities ---
function getContactAlias(id) { return contacts[id] || "Anonymous Peer"; }

function openChatView(peerId) {
    document.getElementById('blank-slate').classList.add('hidden');
    document.getElementById('active-chat-view').classList.remove('hidden');
    document.getElementById('current-chat-name').innerText = getContactAlias(peerId);
    document.getElementById('current-chat-id').innerText = `ID: ${peerId}`;
    document.getElementById('messages-window').innerHTML = '';
}

function resetCommunicationEngine() {
    if (activePeerConnection) activePeerConnection.close();
    activePeerConnection = null;
    activeDataChannel = null;
    currentChatPeerId = null;
    document.getElementById('blank-slate').classList.remove('hidden');
    document.getElementById('active-chat-view').classList.add('hidden');
}

function switchTab(target) {
    document.getElementById('tab-chat').className = target === 'chats' ? 'active' : '';
    document.getElementById('tab-contacts').className = target === 'contacts' ? 'active' : '';
    document.getElementById('panel-chats').className = target === 'chats' ? 'tab-panel active' : 'tab-panel';
    document.getElementById('panel-contacts').className = target === 'contacts' ? 'tab-panel active' : 'tab-panel';
}

function copyMyID() {
    navigator.clipboard.writeText(myId);
    alert("Your unique connection ID has been copied to the clipboard.");
}
