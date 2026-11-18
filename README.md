# TrakFin

Send and track your money. Approve a monthly spending limit once, pay recipients automatically through Open Payments, and see a statement of where your money went (this week or this month).

## 1. One-time wallet setup (wallet.interledger-test.dev)
1. Create an account and deposit play money.
2. Add wallet addresses: one payer (yours) and 2-3 recipients (e.g. rent, savings).
3. Settings > Developer Keys > generate a key for the PAYER account. Save the key ID and private.key.

## 2. Run
    npm install
    cp .env.example .env     # fill in the three values, put private.key in this folder
    npm start                # open http://localhost:3001

## 3. Use
1. Add recipients using their full wallet address URLs.
2. Enter a monthly limit and click "Authorise" -> approve in your wallet -> you return here.
3. Click "Run this month's payments". Each payment does: incoming payment -> quote -> outgoing payment.
4. Read the statement (toggle between this month and this week) and the ledger.
5. Click "Revoke grant" to take back permission at any time.

## Safe testing
Use test wallets only. No real money is involved. Never commit .env or private.key (already in .gitignore).

## Notes and limitations
- Amounts use the payer wallet's currency (whole units, e.g. 5 = 5.00). The test network offers USD, not NGN.
- The callback hash is not verified (prototype).
- Payments run when you click the button; call POST /api/run from a cron job to automate the schedule.

## Next steps
1. Percentage-based rules (for irregular income).
2. Weekly summary emailed automatically to the user.
3. Validate with real users; support naira once providers adopt Open Payments.

## Dependencies
@interledger/open-payments, express, dotenv (see package.json).
