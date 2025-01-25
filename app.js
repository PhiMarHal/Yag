
// Global state
let contract;
let provider;
let signer;
let userAddress;
let dataCache = {
    lastUpdate: 0,
    data: {},
    version: 0,
    pendingUpdates: new Set(),
    processedTransactions: new Set()
};


// State variables
let endTimeValue;
let currentBid;
let lastBidder;
let lastBidderName;
let lastMessage;

// Initialize app
async function initializeApp() {
    try {
        // Set up read-only provider
        provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
        contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONFIG.CONTRACT_ABI, provider);

        // Set up wallet connection button
        setupWalletButton();

        // Set up network change listener
        if (window.ethereum) {
            window.ethereum.on('chainChanged', handleChainChange);
            window.ethereum.on('accountsChanged', handleAccountsChanged);
        }

        // Start periodic data updates
        startPeriodicUpdates();
        initializeAuctionData();

    } catch (error) {
        console.error('Initialization error:', error);
        showStatus(`Initialization error: ${error.message}`, 'error');
    }
}

// Wallet Management
async function connectWallet() {
    if (typeof window.ethereum === 'undefined') {
        showStatus('No Web3 wallet detected. Please install MetaMask or similar.', 'error');
        return false;
    }

    try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        userAddress = accounts[0];

        if (!await checkAndSwitchNetwork()) {
            return false;
        }

        const web3Provider = new ethers.providers.Web3Provider(window.ethereum);
        signer = web3Provider.getSigner();
        contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONFIG.CONTRACT_ABI, signer);

        showStatus('Wallet connected successfully', 'success');
        updateWalletDisplay();
        return true;

    } catch (error) {
        console.error('Wallet connection error:', error);
        showStatus(`Failed to connect wallet: ${error.message}`, 'error');
        return false;
    }
}

function disconnectWallet() {
    userAddress = null;
    signer = null;
    contract = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, CONFIG.CONTRACT_ABI, provider);
    updateWalletDisplay();
    showStatus('Wallet disconnected', 'success');
}

// Network Management
async function checkAndSwitchNetwork() {
    try {
        const chainId = await window.ethereum.request({ method: 'eth_chainId' });

        if (chainId !== CONFIG.NETWORK_ID) {
            showStatus(`Please switch to ${CONFIG.NETWORK_NAME}`, 'warning');

            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: CONFIG.NETWORK_ID }],
                });
            } catch (switchError) {
                if (switchError.code === 4902) {
                    await addNetwork();
                } else {
                    throw switchError;
                }
            }

            return true;
        }

        return true;
    } catch (error) {
        showStatus(`Network switch failed: ${error.message}`, 'error');
        return false;
    }
}

async function addNetwork() {
    try {
        await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
                chainId: CONFIG.NETWORK_ID,
                chainName: CONFIG.NETWORK_NAME,
                nativeCurrency: {
                    name: 'ETH',
                    symbol: 'ETH',
                    decimals: 18
                },
                rpcUrls: [CONFIG.RPC_URL],
                blockExplorerUrls: [CONFIG.EXPLORER_URL]
            }]
        });
    } catch (error) {
        throw new Error(`Failed to add network: ${error.message}`);
    }
}

// Data Management
async function fetchDataBatch(startIndex, batchSize) {
    const promises = [];
    for (let i = 0; i < batchSize && (startIndex + i) < CONFIG.MAX_ITEMS; i++) {
        promises.push(
            contract.getData(startIndex + i)
                .then(data => ({
                    index: startIndex + i,
                    data,
                    error: null
                }))
                .catch(error => ({
                    index: startIndex + i,
                    data: null,
                    error
                }))
        );
    }
    return Promise.all(promises);
}

async function processDataQueue() {
    if (dataCache.isProcessing) return;

    try {
        dataCache.isProcessing = true;

        while (dataCache.pendingUpdates.size > 0) {
            const updates = Array.from(dataCache.pendingUpdates);
            dataCache.pendingUpdates.clear();

            for (let i = 0; i < updates.length; i += CONFIG.BATCH_SIZE) {
                const batch = updates.slice(i, i + CONFIG.BATCH_SIZE);
                await Promise.all(batch.map(updateSingleItem));

                if (i + CONFIG.BATCH_SIZE < updates.length) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        }
    } finally {
        dataCache.isProcessing = false;
        if (dataCache.pendingUpdates.size > 0) {
            processDataQueue();
        }
    }
}

function setupEventListener() {
    if (contract) {
        contract.removeAllListeners("DataUpdated");

        contract.on("DataUpdated", (id, event) => {
            if (dataCache.processedTransactions.has(event.transactionHash)) {
                return;
            }

            dataCache.processedTransactions.add(event.transactionHash);
            dataCache.pendingUpdates.add(id.toNumber());
            processDataQueue();
        });
    }
}

// UI Updates
async function updateWalletDisplay() {
    const walletButton = document.getElementById('wallet-button');
    const registerButton = document.getElementById('register-button');
    const walletName = document.getElementById('wallet-name');
    const walletAddress = document.getElementById('wallet-address');

    if (!userAddress) {
        walletButton.textContent = 'CONNECT WALLET';
        registerButton.style.display = 'none';
        walletName.style.display = 'none';
        walletAddress.style.display = 'none';
        return;
    }

    // Wallet is connected
    walletButton.textContent = 'DISCONNECT';

    // Show address
    walletAddress.textContent = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
    walletAddress.style.display = 'block';

    // Check if user has a registered name
    const name = await contract.addressToName(userAddress);
    if (name) {
        registerButton.style.display = 'none';
        walletName.textContent = name;
        walletName.style.display = 'block';
    } else {
        registerButton.style.display = 'block';
        walletName.style.display = 'none';
    }
}

async function handleRegister() {
    if (!userAddress) {
        showStatus("Please connect your wallet first", "warning");
        return;
    }

    const modal = document.getElementById('register-modal');
    const nameInput = document.getElementById('name-input');
    const submitButton = document.getElementById('submit-name');

    // Character counter
    nameInput.addEventListener('input', function () {
        const charCount = document.getElementById('name-char-count');
        charCount.textContent = this.value.length;
    });

    // Submit handler
    submitButton.onclick = async () => {
        const name = nameInput.value.trim();

        if (!name) {
            showStatus("Please enter a name", "error");
            return;
        }

        if (name.length > 32) {
            showStatus("Name too long (max 32 characters)", "error");
            return;
        }

        try {
            const tx = await contract.register(name);
            modal.style.display = 'none';

            showStatus("Transaction submitted...", "warning");
            await tx.wait();
            showStatus("Name registered successfully!", "success");
            await updateWalletDisplay();

        } catch (error) {
            console.error("Registration failed:", error);
            showStatus(error.message, "error");
        }
    };

    // Show modal
    modal.style.display = 'flex';

    // Close on overlay click
    modal.onclick = (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    };
}

function updateDisplay() {
    const currentWinner = document.getElementById('current-winner');

    if (lastBidder) {
        const address = `${lastBidder.slice(0, 6)}...${lastBidder.slice(-4)}`;
        if (lastBidderName) {
            currentWinner.textContent = `${lastBidderName} (${address})`;
        } else {
            currentWinner.textContent = address;
        }
    } else {
        currentWinner.textContent = 'No bids yet';
    }

    // Update minimum next bid
    const minNextBidElement = document.getElementById('min-next-bid');
    const minIncrement = ethers.utils.parseEther("0.0004");
    const nextMinBid = currentBid ? currentBid.add(minIncrement) : minIncrement;
    minNextBidElement.textContent = `Steal their spot for ${ethers.utils.formatEther(nextMinBid)} ETH`;

    // Add price per YAP calculation
    const pricePerYapElement = document.getElementById('price-per-yap');
    const ethAmount = currentBid ? parseFloat(ethers.utils.formatEther(currentBid)) : 0;
    const dollarAmount = (ethAmount * 3600 / 486).toFixed(4);
    pricePerYapElement.textContent = `(That's about $${dollarAmount} per YAP!)`;

    const messageElement = document.getElementById('winner-message');
    if (messageElement) {
        messageElement.textContent = lastMessage || 'No message yet';
    }
}

function showStatus(message, type = 'info') {
    const statusElement = document.getElementById('status-messages');
    if (!statusElement) return;

    // Simplify common error messages
    let displayMessage = message;
    if (typeof message === 'string') {
        if (message.includes('user rejected')) {
            displayMessage = 'User rejected transaction';
        } else if (message.includes('insufficient funds')) {
            displayMessage = 'Insufficient funds';
        } else if (message.includes('ACTION_REJECTED')) {
            displayMessage = 'Transaction cancelled';
        } else {
            // For other errors, try to extract the human-readable part
            const matches = message.match(/^([^({])+/);
            if (matches) {
                displayMessage = matches[0].trim();
            }
        }
    }

    statusElement.textContent = displayMessage;
    statusElement.className = `status-message ${type}`;

    setTimeout(() => {
        statusElement.className = 'status-message';
    }, 5000);
}

// Event Handlers
function handleChainChange() {
    window.location.reload();
}

function handleAccountsChanged(accounts) {
    if (accounts.length === 0) {
        disconnectWallet();
    } else if (accounts[0] !== userAddress) {
        userAddress = accounts[0];
        connectWallet();
    }
}

// Periodic Updates
function startPeriodicUpdates() {
    // Initial fetch
    initializeAuctionData();

    // Set up periodic updates
    setInterval(() => {
        if (Date.now() - dataCache.lastUpdate > CONFIG.CACHE_DURATION) {
            initializeAuctionData();
        }
    }, CONFIG.UPDATE_INTERVAL);
}

// Setup helpers
function setupWalletButton() {
    const walletButton = document.getElementById('wallet-button');
    if (!walletButton) return;

    walletButton.addEventListener('click', async () => {
        if (userAddress) {
            disconnectWallet();
        } else {
            await connectWallet();
        }
    });
}


async function initializeAuctionData() {
    try {
        endTimeValue = await contract.endTime();
        startTimer();

        // Get the latest bid
        try {
            let latestIndex = 0;
            while (true) {
                try {
                    await contract.bidHistory(latestIndex + 1);
                    latestIndex++;
                } catch {
                    break;
                }
            }

            if (latestIndex >= 0) {
                const latestBid = await contract.bidHistory(latestIndex);
                lastBidder = latestBid.sender;
                currentBid = latestBid.amount;
                lastMessage = latestBid.content;
                lastBidderName = await contract.addressToName(lastBidder);
                updateDisplay();
            }
        } catch (error) {
            console.log("No bids yet or error fetching bid:", error);
        }

        // Listen for new bids
        contract.removeAllListeners("NewBid");
        contract.on("NewBid", (bidder, amount, content, bidIndex) => {
            lastBidder = bidder;
            currentBid = amount;
            lastMessage = content;
            contract.addressToName(bidder).then(name => {
                lastBidderName = name;
                updateDisplay();
            });
        });

    } catch (error) {
        console.error("Failed to initialize auction data:", error);
    }
}

function startTimer() {
    const timerElement = document.getElementById('auction-timer');

    function updateTimer() {
        const now = Math.floor(Date.now() / 1000);
        const end = endTimeValue.toNumber();
        const remaining = end - now;

        if (remaining <= 0) {
            timerElement.textContent = "AUCTION ENDED";
            document.getElementById('contribute-button').disabled = true;
            return;
        }

        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        const seconds = remaining % 60;

        timerElement.textContent =
            `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    updateTimer();
    setInterval(updateTimer, 1000);
}

let modalVisible = false;

async function contribute() {
    if (!userAddress) {
        try {
            const connected = await connectWallet();
            if (!connected) {
                showStatus("Could not connect wallet", "error");
                return;
            }
        } catch (error) {
            console.error("Wallet connection failed:", error);
            showStatus("Wallet connection failed: " + error.message, "error");
            return;
        }
    }

    const modal = document.getElementById('bid-modal');
    const bidInput = document.getElementById('bid-amount');
    const messageInput = document.getElementById('bid-message');
    const submitButton = document.getElementById('submit-bid');
    const previousBidsInfo = document.getElementById('previous-bids-info');

    // Get minimum bid and user's previous bids
    const minIncrement = ethers.utils.parseEther("0.0004");
    const nextMinBid = currentBid ? currentBid.add(minIncrement) : minIncrement;
    const userFullBid = await contract.fullBids(userAddress);

    // Set initial bid amount to minimum required
    bidInput.value = ethers.utils.formatEther(nextMinBid);
    bidInput.min = ethers.utils.formatEther(nextMinBid);

    // Function to update the previous bids info
    const updatePreviousBidsInfo = () => {
        try {
            const bidAmount = ethers.utils.parseEther(bidInput.value || '0');
            const amountToSend = bidAmount.sub(userFullBid);
            if (userFullBid.gt(0)) {
                previousBidsInfo.style.display = 'block';
                previousBidsInfo.textContent = `Your previous bids amount to ${ethers.utils.formatEther(userFullBid)} ETH. You will only send ${ethers.utils.formatEther(amountToSend)} ETH.`;
            } else {
                previousBidsInfo.style.display = 'none';
            }
        } catch (error) {
            console.error("Error updating bid info:", error);
        }
    };

    // Initial update of previous bids info
    updatePreviousBidsInfo();

    // Update whenever bid amount changes
    bidInput.addEventListener('input', updatePreviousBidsInfo);

    // Character counter
    messageInput.addEventListener('input', function () {
        const charCount = document.getElementById('char-count');
        charCount.textContent = this.value.length;
        if (this.value.length > 256) {
            charCount.style.color = '#ff3e3e';
            submitButton.disabled = true;
        } else {
            charCount.style.color = '#999';
            submitButton.disabled = false;
        }
    });

    // Submit handler
    submitButton.onclick = async () => {
        const bidAmount = ethers.utils.parseEther(bidInput.value);
        const message = messageInput.value;

        if (message.length > 256) {
            showStatus("Message too long (max 256 characters)", "error");
            return;
        }

        try {
            // Calculate actual amount to send (new bid minus previous bids)
            const amountToSend = bidAmount.sub(userFullBid);
            const tx = await contract.contribute(message, {
                value: amountToSend
            });

            modal.style.display = 'none';
            modalVisible = false;

            showStatus("Transaction submitted...", "warning");
            await tx.wait();
            showStatus("Bid placed successfully!", "success");

        } catch (error) {
            console.error("Contribution failed:", error);
            showStatus(error.message, "error");
        }
    };

    // Show modal
    modal.style.display = 'flex';
    modalVisible = true;

    // Close on overlay click
    modal.onclick = (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
            modalVisible = false;
        }
    };
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalVisible) {
        document.getElementById('bid-modal').style.display = 'none';
        modalVisible = false;
    }
});

document.getElementById('register-button').addEventListener('click', handleRegister);

// Initialize on load
window.addEventListener('load', async () => {
    await initializeApp();
    await initializeAuctionData();

    // Set up contribute button
    document.getElementById('contribute-button').addEventListener('click', contribute);
});
