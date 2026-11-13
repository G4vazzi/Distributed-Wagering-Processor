
$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:3000/v1"
$playerId = [guid]::NewGuid().ToString()

Write-Host "`n=== 1. HEALTH CHECK ==="

$health = Invoke-RestMethod `
    -Uri "$baseUrl/health" `
    -Method Get

Write-Host "API: $($health.status)"
Write-Host "Database: $($health.database)"

Write-Host "`n=== 2. OPEN WALLET ==="

$walletPayload = @{
    playerId = $playerId
    initialBalance = @{
        amount = "100.00"
        currency = "BRL"
    }
}

$wallet = Invoke-RestMethod `
    -Uri "$baseUrl/wallets" `
    -Method Post `
    -ContentType "application/json" `
    -Body ($walletPayload | ConvertTo-Json -Depth 8)

Write-Host "Wallet ID: $($wallet.id)"

Write-Host "`n=== 3. BET DE R$ 80,00 ==="

$betId = [guid]::NewGuid().ToString()
$betKey = "test:$betId"

$betPayload = @{
    kind = "BET"
    providerId = "provider-smoke"
    externalTransactionId = $betId
    playerId = $playerId
    walletId = $wallet.id
    roundId = "round-smoke"
    gameId = "game-smoke"
    money = @{
        amount = "80.00"
        currency = "BRL"
    }
}

$betHeaders = @{
    "Idempotency-Key" = $betKey
}

$bet = Invoke-RestMethod `
    -Uri "$baseUrl/transactions" `
    -Method Post `
    -Headers $betHeaders `
    -ContentType "application/json" `
    -Body ($betPayload | ConvertTo-Json -Depth 8)

Write-Host "BET status: $($bet.status)"
Write-Host "Balance: $($bet.balance.amount)"

if (
    $bet.status -ne "PROCESSED" -or
    $bet.balance.amount -ne "20.00"
) {
    throw "BET validation failed"
}

Write-Host "`n=== 4. IDEMPOTENCY REPLAY ==="

$replay = Invoke-RestMethod `
    -Uri "$baseUrl/transactions" `
    -Method Post `
    -Headers $betHeaders `
    -ContentType "application/json" `
    -Body ($betPayload | ConvertTo-Json -Depth 8)

Write-Host "Replay: $($replay.idempotentReplay)"

if (
    $replay.idempotentReplay -ne $true -or
    $replay.transactionId -ne $bet.transactionId
) {
    throw "Idempotency validation failed"
}

Write-Host "`n=== 5. REFUND DA BET ==="

$refundId = [guid]::NewGuid().ToString()

$refundPayload = @{
    kind = "REFUND"
    providerId = "provider-smoke"
    externalTransactionId = $refundId
    playerId = $playerId
    walletId = $wallet.id
    roundId = "round-smoke"
    gameId = "game-smoke"
    referenceExternalTransactionId = $betId
    money = @{
        amount = "80.00"
        currency = "BRL"
    }
}

$refund = Invoke-RestMethod `
    -Uri "$baseUrl/transactions" `
    -Method Post `
    -Headers @{
        "Idempotency-Key" = "test:$refundId"
    } `
    -ContentType "application/json" `
    -Body ($refundPayload | ConvertTo-Json -Depth 8)

Write-Host "REFUND status: $($refund.status)"
Write-Host "Balance: $($refund.balance.amount)"

if (
    $refund.status -ne "PROCESSED" -or
    $refund.balance.amount -ne "100.00"
) {
    throw "REFUND validation failed"
}

Write-Host "`n=== 6. FINAL BALANCE ==="

$finalWallet = Invoke-RestMethod `
    -Uri "$baseUrl/wallets/$($wallet.id)" `
    -Method Get

Write-Host "Final balance: $($finalWallet.balance.amount)"

if ($finalWallet.balance.amount -ne "100.00") {
    throw "Final balance mismatch"
}

Write-Host "`nHTTP SMOKE TEST PASSED"
