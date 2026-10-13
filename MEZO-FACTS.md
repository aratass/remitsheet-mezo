# Mezo facts checked on 13 Oct 2026 (live RPC calls from the browser)

Chains
- Testnet: chain 31611 (0x7b7b), RPC https://rpc.test.mezo.org, explorer https://explorer.test.mezo.org, block gas limit 10,000,000, block time about 4.8 s, gas price about 146 wei.
- Mainnet: chain 31612 (0x7b7c), RPCs with open CORS and eth_call: https://rpc-http.mezo.boar.network and https://mainnet.mezo.public.validationcloud.io (mezo.drpc.org answers eth_chainId but refuses eth_call on the free tier). Explorer https://explorer.mezo.org.
- Native gas token: BTC, 18 decimals. Cancun opcodes work (PUSH0, MCOPY, TSTORE checked with eth_call).
- CREATE2 factory 0x4e59b44847b379578588920cA78FbF26c0B4956C exists on both chains.
- Archive state: eth_call at blocks 1,000,000 back works on both public RPCs.

Tokens (same precompile addresses on both chains, stub bytecode so extcodesize > 0)
- BTC ERC-20 precompile: 0x7b7C000000000000000000000000000000000000, 18 decimals, EIP-2612 permit, domain name "BTC", version "1".
- MEZO precompile: 0x7B7c000000000000000000000000000000000001, 18 decimals, EIP-2612 permit (returns bool, v must be 27 or 28), domain name "MEZO", version "1", no eip712Domain().
- MUSD testnet: 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503; MUSD mainnet: 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186. OpenZeppelin ERC20Permit, name "Mezo USD", version "1", 18 decimals, eip712Domain() available.

Borrowing system (mezo-org/musd artifacts, checked on chain)
- Testnet: TroveManager 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0, PriceFeed 0x86bCF0841622a5dAC14A313a15f96A95421b9366, BorrowerOperations 0xCdF7028ceAB81fA0C6971208e83fa7872994beE5, InterestRateManager 0xD4D6c36A592A2c5e86035A6bca1d57747a567f37, BorrowerOperationsSignatures 0xD757e3646AF370b15f32EB557F0F8380Df7D639e.
- Mainnet: TroveManager 0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193, PriceFeed 0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88, BorrowerOperations 0x44b1bac67dDA612a41a58AAf779143B181dEe031, InterestRateManager 0x4a453700d157717Fe02fB62E7700ED7845048285, BorrowerOperationsSignatures 0xB57ab578BF20b3e318f3EFAA587C51DBccE5df7a.
- Testnet values: MCR 110%, CCR 150%, minimum net debt 1,800 MUSD, gas compensation 200 MUSD, borrowing rate 0.1%, interest rate 100 basis points (1%), BTC price about 83,150 USD.
- PriceFeed.fetchPrice() is a view (18 decimals), oracle is the price precompile 0x7b7c000000000000000000000000000000000015.

Gas measured with eth_estimateGas on testnet
- MEZO precompile transfer: 25,552 total (about 4,500 above the 21,000 base).
- MUSD transfer to a new address: 51,685 total.
- BTC value transfer to a new address: 21,000.
