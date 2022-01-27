const express = require('express');
const os = require('os');
const app = express();
const bodyParser = require('body-parser');
const Blockchain = require('./blockchain');
const uuid = require('uuid/v1');
const port = process.argv[2];
const rp = require('request-promise');
const nodeAddress = uuid().split('-').join('');
const bitcoin = new Blockchain();
const hostName = os.hostname();
const cpuCount = os.cpus().length;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

/*
https://github.com/websockets/ws
websocket library 
*/

/*	COLLECT NODE INFORMATION
	use os.js https://nodejs.org/api/os.html
	os.arch() Returns CPU Architecture as string such as 'arm', 'arm64', etc
	os.cpus() Returns an array of objects containing information about each logical CPU core
	os.loadavg() Returns an array containing the 1, 5, and 15 minute load averages.
	os.platform() Returns a string identifying the operating system platform. The value is set at compile time. Possible values are 'aix','darwin', 'freebsd', 'linux', 'openbsd', 'sunos', and 'win32'.
	os.uptime()	Returns the system uptime in number of seconds.
*/

// get entire blockchain
app.get('/blockchain', function (req, res) {
	res.send(bitcoin);
});


// create a new transaction
app.post('/transaction', function (req, res) {
	const newTransaction = req.body;
	const blockIndex = bitcoin.addTransactionToPendingTransactions(newTransaction);
	res.json({ note: `Transaction will be added in block ${blockIndex}.` });
});


// broadcast transaction to all the other nodes
app.post('/transaction/broadcast', function (req, res) {
	const newTransaction = bitcoin.createNewTransaction(req.body.amount, req.body.sender, req.body.recipient);
	bitcoin.addTransactionToPendingTransactions(newTransaction);

	const requestPromises = [];
	bitcoin.networkNodes.forEach(networkNodeUrl => {
		const requestOptions = {
			uri: networkNodeUrl + '/transaction',
			method: 'POST',
			body: newTransaction,
			json: true
		};

		requestPromises.push(rp(requestOptions));
	});

	Promise.all(requestPromises)
		.then(data => {
			res.json({ note: 'Transaction created and broadcast successfully.' });
		});
});


/*  MINE BLOCK
  move this to miner client side code
  ..................................................
  replace this with a register miner endpoint
	  app.get('/miner-registration', (req, res)) {
		  
	  add new miner to array of available miners and send minerList to all other nodes

	  }


  ASSIGN WORK TO MINER
  
  1 - Assigns work to miner on availableMiner list
  2 - Determines miner difficulty
  3 - Removes miner from availableMiner list
  4 - Recieves nonce, hashrate to determine difficulty
  5 - Checks to see if valid
  6 - Creates miner reward block
  7 - Adds miner to availableMiner list

  ADD new endpoint to recieve work back from miner, assign new work broadcast update to other nodes


 BELOW CODE GETS MOVED TO CLIENT MINER
 .......................................................
 also add a minerRes endpoint to recieve 
*/


app.get('/mine', function (req, res) {
	const lastBlock = bitcoin.getLastBlock();
	const previousBlockHash = lastBlock['hash'];
	const currentBlockData = {
		transactions: bitcoin.pendingTransactions,
		index: lastBlock['index'] + 1
	};
	const nonce = bitcoin.proofOfWork(previousBlockHash, currentBlockData);
	const blockHash = bitcoin.hashBlock(previousBlockHash, currentBlockData, nonce);
	const newBlock = bitcoin.createNewBlock(nonce, previousBlockHash, blockHash);

	const requestPromises = [];
	bitcoin.networkNodes.forEach(networkNodeUrl => {
		const requestOptions = {
			uri: networkNodeUrl + '/receive-new-block',
			method: 'POST',
			body: { newBlock: newBlock },
			json: true
		};

		requestPromises.push(rp(requestOptions));
	});

	/*	MINER REWARD
	 
		ADD REWARDS TO NODE WORK
	*/
	Promise.all(requestPromises)
		.then(data => {
			const requestOptions = {
				uri: bitcoin.currentNodeUrl + '/transaction/broadcast',
				method: 'POST',
				body: {
					amount: 12.5,
					sender: "00",
					recipient: nodeAddress
				},
				json: true
			};

			return rp(requestOptions);
		})
		.then(data => {
			res.json({
				note: "New block mined & broadcast successfully",
				block: newBlock
			});
		});
});

/*
 receive new block - sync blocks accross network nodes
*/

app.post('/receive-new-block', function (req, res) {
	const newBlock = req.body.newBlock;
	const lastBlock = bitcoin.getLastBlock();
	const correctHash = lastBlock.hash === newBlock.previousBlockHash;
	const correctIndex = lastBlock['index'] + 1 === newBlock['index'];

	if (correctHash && correctIndex) {
		bitcoin.chain.push(newBlock);
		bitcoin.pendingTransactions = [];
		res.json({
			note: 'New block received and accepted.',
			newBlock: newBlock
		});
	} else {
		res.json({
			note: 'New block rejected.',
			newBlock: newBlock
		});
	}
});

/*
 NEW NODE REGISTRATION PART 1 -  Node is added and broadcast to network
 receives new node information and sends it to all nodes already in the network
*/
app.post('/register-and-broadcast-node', function (req, res) {
	const newNodeUrl = req.body.newNodeUrl;
	if (bitcoin.networkNodes.indexOf(newNodeUrl) == -1) bitcoin.networkNodes.push(newNodeUrl);

	const regNodesPromises = [];
	bitcoin.networkNodes.forEach(networkNodeUrl => {
		const requestOptions = {
			uri: networkNodeUrl + '/register-node',
			method: 'POST',
			body: { newNodeUrl: newNodeUrl },
			json: true
		};

		regNodesPromises.push(rp(requestOptions));
	});

	Promise.all(regNodesPromises)
		.then(data => {
			const bulkRegisterOptions = {
				uri: newNodeUrl + '/register-nodes-bulk',
				method: 'POST',
				body: { allNetworkNodes: [...bitcoin.networkNodes, bitcoin.currentNodeUrl] },
				json: true
			};

			return rp(bulkRegisterOptions);
		})
		.then(data => {
			res.json({ note: 'New node registered with network successfully.' });
		});
});


/*
NEW NODE REGISTRATION PART 2 - register new node with the remaining network
*/
app.post('/register-node', function (req, res) {
	const newNodeUrl = req.body.newNodeUrl;
	const nodeNotAlreadyPresent = bitcoin.networkNodes.indexOf(newNodeUrl) == -1;
	const notCurrentNode = bitcoin.currentNodeUrl !== newNodeUrl;
	if (nodeNotAlreadyPresent && notCurrentNode) bitcoin.networkNodes.push(newNodeUrl);
	res.json({ note: 'New node registered successfully.' });
});


/* register multiple nodes at once
  NEW NODE REGISTRATION PART 3 - New node receives list of all network nodes 
  Register multiple nodes at once
  The new node receives this list of all other nodes on tne network after all other nodes add it
  add CONSENSUS code to registration 
	  so that new node has current blockchain
  ......................................................................................
*/
app.post('/register-nodes-bulk', function (req, res) {
	const allNetworkNodes = req.body.allNetworkNodes;
	allNetworkNodes.forEach(networkNodeUrl => {
		const nodeNotAlreadyPresent = bitcoin.networkNodes.indexOf(networkNodeUrl) == -1;
		const notCurrentNode = bitcoin.currentNodeUrl !== networkNodeUrl;
		if (nodeNotAlreadyPresent && notCurrentNode) bitcoin.networkNodes.push(networkNodeUrl);
	});
	/*
	new node checks the other nodes for the current blockchain. It updates to the longest blockchain
	*/
	const requestPromises = [];
	bitcoin.networkNodes.forEach(networkNodeUrl => {
		const requestOptions = {
			uri: networkNodeUrl + '/blockchain',
			method: 'GET',
			json: true
		};

		requestPromises.push(rp(requestOptions));
	});

	Promise.all(requestPromises)
		.then(blockchains => {
			const currentChainLength = bitcoin.chain.length;
			let maxChainLength = currentChainLength;
			let newLongestChain = null;
			let newPendingTransactions = null;

			blockchains.forEach(blockchain => {
				if (blockchain.chain.length > maxChainLength) {
					maxChainLength = blockchain.chain.length;
					newLongestChain = blockchain.chain;
					newPendingTransactions = blockchain.pendingTransactions;
				};
			});


			if (!newLongestChain || (newLongestChain && !bitcoin.chainIsValid(newLongestChain))) {
				res.json({
					note: 'Current chain has not been replaced.',
					chain: bitcoin.chain
				});
			}
			else {
				bitcoin.chain = newLongestChain;
				bitcoin.pendingTransactions = newPendingTransactions;
				res.json({
					note: 'This chain has been replaced.',
					chain: bitcoin.chain
				});
			}
		});
	res.json({ note: 'Bulk registration successful.' });
});


/*
CONSENSUS -  Check with all other nodes to find the longest blockchain length. If the length is greater then yours, update with the longest blockchain
			  
This endpoint is a manual blockchain update

 ........................................................................
*/

app.get('/consensus', function (req, res) {
	const requestPromises = [];
	bitcoin.networkNodes.forEach(networkNodeUrl => {
		const requestOptions = {
			uri: networkNodeUrl + '/blockchain',
			method: 'GET',
			json: true
		};

		requestPromises.push(rp(requestOptions));
	});

	Promise.all(requestPromises)
		.then(blockchains => {
			const currentChainLength = bitcoin.chain.length;
			let maxChainLength = currentChainLength;
			let newLongestChain = null;
			let newPendingTransactions = null;

			blockchains.forEach(blockchain => {
				if (blockchain.chain.length > maxChainLength) {
					maxChainLength = blockchain.chain.length;
					newLongestChain = blockchain.chain;
					newPendingTransactions = blockchain.pendingTransactions;
				};
			});


			if (!newLongestChain || (newLongestChain && !bitcoin.chainIsValid(newLongestChain))) {
				res.json({
					note: 'Current chain has not been replaced.',
					chain: bitcoin.chain
				});
			}
			else {
				bitcoin.chain = newLongestChain;
				bitcoin.pendingTransactions = newPendingTransactions;
				res.json({
					note: 'This chain has been replaced.',
					chain: bitcoin.chain
				});
			}
		});
});


/*
  BLOCKCHAIN EXPLORER
  ......................................................................
	  get block by blockHash
*/
app.get('/block/:blockHash', function (req, res) {
	const blockHash = req.params.blockHash;
	const correctBlock = bitcoin.getBlock(blockHash);
	res.json({
		block: correctBlock
	});
});


// get transaction by transactionId
app.get('/transaction/:transactionId', function (req, res) {
	const transactionId = req.params.transactionId;
	const trasactionData = bitcoin.getTransaction(transactionId);
	res.json({
		transaction: trasactionData.transaction,
		block: trasactionData.block
	});
});


// get address by address
app.get('/address/:address', function (req, res) {
	const address = req.params.address;
	const addressData = bitcoin.getAddressData(address);
	res.json({
		addressData: addressData
	});
});


// block explorer
app.get('/block-explorer', function (req, res) {
	res.sendFile('./block-explorer/index.html', { root: __dirname });
});



/*
 NODE LOAD BALANCING

  https://www.npmjs.com/package/load-balancers/v/1.3.205
  npm install --save load-balancers
 ...............................................................


  import {
	  P2cBalancer,
	  RandomBalancer,
  } from 'load-balancers';

 TODO: Update this list with your proxies or virtual machines. 
  const proxies = [
	  'https://node01.raspi.server',
	  'https://node02.raspi.server',
	  'https://node03.raspi.server',
	  'https://node04.raspi.server',
	  'https://node05.raspi.server',
	  'https://node06.raspi.server',
	  'https://node07.raspi.server',
	  'https://node08.raspi.server',
	  'https://node09.raspi.server',
	  'https://node10.raspi.server',
  ];

 Initializes the Power of 2 Choices (P2c) Balancer with ten proxies.
  const balancer = new P2cBalancer(proxies.length);

 P2c Balancer is preferred over the Random Balancer.
 const balancer = new RandomBalancer(proxies.length);

  for (let i = 0; i < 1e6; i++) {
	  const proxy = proxies[balancer.pick()];

 TODO: Use the assigned proxy to scrape a website,
 shift traffic to a virtual machine etc.
*/

app.listen(port, function () {
	console.log(`berryNet ${hostName} with ${cpuCount} CPU cores is listening on port ${port}... to quit enter [control] + c`);
});





