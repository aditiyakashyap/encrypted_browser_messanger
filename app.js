// --- Global State & Cryptography ---
let myId = "";
let idVisible = false;
let signalingBroker = null;
let currentChatPeerId = null;

// Local Memory
let activeChats = []; 
let cachedOffers = {}; // Stores pending requests and their Public Keys
let sharedSecrets = {}; // Stores AES keys mapped to Peer IDs

// ECDH Key Pair for this session
let localKeyPair = null;
let localPublicKeyJWK = null;

window.addEventListener('DOMContentLoaded', async () => {
    generateUserIdentity();
    await initializeCrypto();
    initializeRelaySystem();
    updateSidebarUI();
});

// --- 1. Identity & Cryptography Engine ---
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

async function initializeCrypto() {
    // Generate an Elliptic Curve keypair for secure key exchange
    localKeyPair = await window.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"]
    );
    localPublicKeyJWK = await window.crypto.subtle.exportKey("jwk", localKeyPair.publicKey);
}

async function deriveAESKey(peerPublicKeyJWK, peerId) {
    // Import the peer's public key
    const peerKey = await window.crypto.subtle.importKey(
        "jwk",
        peerPublicKeyJWK,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
    );
    // Mix our private key with their public key to create a shared AES secret
    const sharedSecret = await window.crypto.subtle.deriveKey(
        { name: "ECDH", public: peerKey },
        localKeyPair.privateKey,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
    sharedSecrets[peerId] = sharedSecret;
}

// --- 2. The Blind Relay (Standard Internet Transmission) ---
function initializeRelaySystem() {
    // Using a reliable public broker over standard port 443/8443/8084 WebSockets
    signalingBroker = mqtt.connect('wss://broker.emqx.io:8084/mqtt');
    
    signalingBroker.on('connect', () => {
        signalingBroker.subscribe(`ghoststream/chat/${myId}`);
    });

    signalingBroker.on('message', async (topic, payload) => {
        const packet = JSON.parse(payload.toString());
        
        if (packet.type === 'request') {
            // Incoming connection request (Contains their Public Key)
            cachedOffers[packet.sender] = packet.pubKey;
            updateSidebarUI();

        } else if (packet.type === 'accept') {
            // Peer accepted our request (Contains their Public Key)
            await deriveAESKey(packet.pubKey, packet.sender);
            trackActiveChatSession(packet.sender);
            openActiveChatView(packet.sender, "Secure Link Established");

        } else if (packet.type === 'deny') {
            alert("Connection request was denied by the peer.");
            resetCommunicationEngine();

        } else if (packet.type === 'message') {
            // Incoming Encrypted Message
            if (!sharedSecrets[packet.sender]) return; // Drop if we don't have the key
            
            try {
                const decryptedText = await decryptMessage(packet.cipher, packet.iv, packet.sender);
                if (currentChatPeerId === packet.sender) {
                    renderBubble(decryptedText, 'received');
                } else {
                    // If chat isn't open, just track that they are active
                    trackActiveChatSession(packet.sender);
                }
            } catch (err) {
                console.error("Decryption failed. Unrecognized payload.");
            }
        }
    });
}

// --- 3. Connection Handshakes ---
function requestPeerConnection() {
    const peerId = document.getElementById('connect-peer-id').value.trim();
    if (!peerId || peerId === myId) return alert("Invalid Peer ID.");

    closeNewChatModal();
    currentChatPeerId = peerId;

    // Send connection request + our public key
    signalingBroker.publish(`ghoststream/chat/${peerId}`, JSON.stringify({
        type: 'request',
        sender: myId,
        pubKey: localPublicKeyJWK
    }));

    trackActiveChatSession(peerId);
    openActiveChatView(peerId, "Waiting for peer to accept...");
}

async function handleAllow() {
    const senderId = currentChatPeerId;
    const peerPubKey = cachedOffers[senderId];
    
    // Derive AES key from their public key
    await deriveAESKey(peerPubKey, senderId);

    // Tell them we accepted, and send our public key back
    signalingBroker.publish(`ghoststream/chat/${senderId}`, JSON.stringify({
        type: 'accept',
        sender: myId,
        pubKey: localPublicKeyJWK
    }));

    delete cachedOffers[senderId];
    trackActiveChatSession(senderId);
    openActiveChatView(senderId, "Secure Link Established");
}

function handleDeny() {
    if(!currentChatPeerId) return;
    signalingBroker.publish(`ghoststream/chat/${currentChatPeerId}`, JSON.stringify({
        type: 'deny',
        sender: myId
    }));
    delete cachedOffers[currentChatPeerId];
    currentChatPeerId = null;
    updateSidebarUI();
    switchView('view-blank');
}

// --- 4. Encryption & Messaging ---
async function encryptMessage(text, peerId) {
    const key = sharedSecrets[peerId];
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encodedText = new TextEncoder().encode(text);
    
    const cipherBuffer = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        key,
        encodedText
    );
    
    return {
        cipher: Array.from(new Uint8Array(cipherBuffer)),
        iv: Array.from(iv)
    };
}

async function decryptMessage(cipherArray, ivArray, peerId) {
    const key = sharedSecrets[peerId];
    const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(ivArray) },
        key,
        new Uint8Array(cipherArray)
    );
    return new TextDecoder().decode(decryptedBuffer);
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const msgText = input.value.trim();
    if (!msgText || !currentChatPeerId || !sharedSecrets[currentChatPeerId]) return;

    // Encrypt the message locally
    const encryptedPayload = await encryptMessage(msgText, currentChatPeerId);

    // Send the locked vault via the blind relay
    signalingBroker.publish(`ghoststream/chat/${currentChatPeerId}`, JSON.stringify({
        type: 'message',
        sender: myId,
        cipher: encryptedPayload.cipher,
        iv: encryptedPayload.iv
    }));

    renderBubble(msgText, 'sent');
    input.value = '';
}

// --- 5. UI Logic (Unchanged from previous WhatsApp Design) ---
function toggleIDVisibility() {
    const idSpan = document.getElementById('my-unique-id');
    idVisible = !idVisible;
    if (idVisible) {
        idSpan.innerText = myId;
        idSpan.classList.remove('censored');
        navigator.clipboard.writeText(myId);
        setTimeout(() => {
            idVisible = false;
            idSpan.innerText = "***-***-***";
            idSpan.classList.add('censored');
        }, 3000);
    }
}

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

    Object.keys(cachedOffers).forEach(senderId => {
        const li = document.createElement('li');
        li.className = 'chat-item pending';
        li.innerHTML = `<div class="avatar" style="background-color: #f59e0b;">?</div><div class="details"><span class="title">${senderId}</span><span class="subtitle">Incoming connection request</span></div>`;
        li.onclick = () => openPendingRequestView(senderId);
        list.appendChild(li);
    });

    activeChats.forEach(id => {
        const li = document.createElement('li');
        li.className = 'chat-item';
        li.innerHTML = `<div class="avatar" style="background-color: #6366f1;">${id.charAt(0)}</div><div class="details"><span class="title">${id}</span><span class="subtitle">Tap to chat</span></div>`;
        li.onclick = () => {
            if (currentChatPeerId !== id) {
                currentChatPeerId = id;
                openActiveChatView(id, sharedSecrets[id] ? "Online" : "Session Expired");
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
    document.getElementById('messages-window').innerHTML = ''; 
    switchView('view-chat');
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
    currentChatPeerId = null;
    switchView('view-blank');
}

function openNewChatModal() { document.getElementById('new-chat-modal').classList.remove('hidden'); }
function closeNewChatModal() { document.getElementById('new-chat-modal').classList.add('hidden'); }
