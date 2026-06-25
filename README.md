# GhostStream // Zero-Server P2P Encrypted Messenger

GhostStream is a fully decentralized, browser-based messaging application. It operates entirely peer-to-peer (P2P) without any centralized backend database, user accounts, or message storage. 

All routing is handled client-side, and all memory is stored locally on the user's device. 

## Core Architecture
* **Networking:** WebRTC (Web Real-Time Communication) for direct browser-to-browser data streams.
* **Signaling:** MQTT over WebSockets via a public, blind broker (`broker.emqx.io`). The broker routes the initial connection handshake but cannot read the payloads and drops out once the P2P link is established.
* **Encryption:** Native Web Crypto API (AES-GCM 256-bit).
* **Storage:** Native browser `localStorage` (Acts as the isolated device database for contacts and your generated ID).

## Features
- **Zero Cloud Footprint:** No messages, media, or metadata ever touch a database.
- **Anonymous Identity:** Accounts are mathematical ID strings generated locally on your device.
- **Local Contact Book:** Save peer IDs locally with custom alias names.
- **Consent-Based Connections:** All inbound connections require manual Allow/Deny approval.
- **Ephemeral State:** Refreshing the browser instantly burns the secure tunnel and wipes the active chat session from memory.

## Repository Structure
```text
/
├── index.html   # Main application interface and structure
├── styles.css   # Dark/Modern UI styling
├── app.js       # Core logic, WebRTC, MQTT signaling, and crypto
└── README.md    # Documentation
