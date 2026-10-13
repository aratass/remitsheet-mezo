# Your steps for the Mezo Buildathon entry (about 25 minutes in total)

Remitsheet for Mezo is built and tested. The program needs a working deployment on Mezo testnet, your AKINDO registration and your submission, so a few steps need your accounts and your Rabby wallet. Everything costs nothing: testnet coins are free.

- Wave 1 deadline: **26 Oct 2026, 17:00 Vilnius time** (15:00 UTC). The submission form opens on 16 Oct.
- Your Rabby main address (the same one as for Arc): `0x014B4B400e7Ff5dB666af4e16e6C91b8443b24E6`
- Never share your wallet's recovery words with anyone.

Steps marked **[agents]** are done for you.

---

## 1. Register for the Buildathon (5 min)
1. Open https://app.akindo.io/wave-hacks/OVOO0gdrVU8379D10 and sign in (the button at the top right).
2. Click **Join Buildathon** and answer the registration questions:
   - Full name, email, Telegram `@Herbzzz`, Discord handle, GitHub `aratass`
   - Experience level: **mid**. Focus area: **EVM**.
   - Already have a product: **yes** (Remitsheet). Based in: **Lithuania**. Continue after the hackathon: **yes**.
3. Agree to the Terms of Participation and save.

## 2. Mezo Discord (3 min)
**[agents]** joined the Mezo server for you on 13 Oct (with your OK). Before anyone can post there, Discord needs two checks only you can do:
1. In Discord (Chrome or the app), open the **Mezo** server. At the bottom it says you must verify your phone: click **Patvirtink telefoną** (Verify phone) and follow the steps.
2. In the **#verification** channel, click **Verify** and complete the captcha on captcha.bot.
3. Tell us "discord ok". We then post: `Hi, I'm a Mezo Buildathon participant (AKINDO, Wave 1). Could I get the Developer role, please?`

## 3. Get free test BTC and MEZO (2 min)
1. Open https://faucet.test.mezo.org/
2. Paste your main address, solve the check, and request the coins. They arrive within a minute.

## 4. Deploy Remitsheet on Mezo testnet (3 min)
**[agents]** done: the code and the website are public since 13 Oct.
1. Open https://aratass.github.io/remitsheet-mezo/#/deploy
2. Click **Connect wallet** → **Rabby**. When the app asks, approve **adding Mezo Testnet** and switching to it.
3. Click **Deploy on Mezo testnet** and confirm in Rabby. The fee is far below one satoshi.
4. Wait for the green "Remitsheet is live on Mezo testnet" box.

## 5. Make the first payout (5 min)
1. Click **Pay** at the top. Under **Asset**, choose **MEZO**.
2. Paste this into the Recipients box (it pays 1 MEZO to yourself):
   ```
   address,amount,label
   0x014B4B400e7Ff5dB666af4e16e6C91b8443b24E6,1,Testnet payout
   ```
3. Click **Pay 1 recipient**. Rabby asks twice: first **sign** the permit (free), then **confirm** the transaction.
4. When it says "Paid 1 recipient", click **Open receipt** and copy the page address from the browser bar. Send it to us.

Optional but better for the score (5 more minutes): get test MUSD at https://testnet.mezo.org (swap a little test BTC to MUSD, or borrow), then repeat step 5 with **MUSD** and amount `10`.

## 6. Submit (from 16 Oct, 5 min)
**[agents]** we fill in the receipt link and the video link in SUBMISSION.md, and can fill the AKINDO form for you in Chrome if you are signed in.
1. On the program page, click **Submit** for Wave 1.
2. Copy each field from SUBMISSION.md (https://github.com/aratass/remitsheet-mezo/blob/main/SUBMISSION.md).
3. Deck: `submission/deck.pdf`. Pitch video: `submission/pitch-video.mp4` (upload it to YouTube as **Unlisted** if the form wants a video link).

## 7. If Mezo selects the project (after 23 Nov)
Mezo emails a KYB request: ID, proof of address, a W-8BEN form and your wallet address. The reward is paid in MEZO to that wallet.
