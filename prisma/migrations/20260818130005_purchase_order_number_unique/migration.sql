-- Second idempotency key for Purchase, alongside (userId, gmailMessageId):
-- orderNumber identifies the real-world order, stronger than one email
-- about it. Postgres treats multiple NULLs as distinct, so orderNumber-less
-- rows are unaffected. Applied only after scripts/dedupe-purchases.ts
-- --apply collapsed the existing duplicate rows (102 -> 53), which this
-- constraint would otherwise reject.
CREATE UNIQUE INDEX "Purchase_userId_orderNumber_key" ON "Purchase"("userId", "orderNumber");
