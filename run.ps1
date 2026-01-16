Write-Host "Starting FundMatrix Dashboard..." -ForegroundColor Cyan
Start-Process "http://127.0.0.1:5000"
python app.py
Read-Host -Prompt "Press Enter to exit"
