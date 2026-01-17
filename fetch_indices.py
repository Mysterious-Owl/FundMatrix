import yfinance as yf
import os
import pandas as pd
from datetime import datetime

# CONFIGURATION
OUTPUT_DIR = 'indices'
TICKERS = {
    'Nifty_50': '^NSEI',
    'Nifty_BANK': '^NSEBANK',
    'Nifty_500': '^NIFTY500',
    'Sensex': '^BSESN',
    'Gold': 'GC=F',
    'Silver': 'SI=F'
}

def fetch_data():
    """Fetches data for Indian indices and commodities using yfinance."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    print(f"Starting data fetch at {datetime.now()}...")
    
    for name, ticker_symbol in TICKERS.items():
        print(f"Fetching data for {name} ({ticker_symbol})...")
        try:
            # Fetch data for the last 1 year with daily interval
            ticker = yf.Ticker(ticker_symbol)
            df = ticker.history(period="max")
            
            if df.empty:
                print(f"Warning: No data found for {name} ({ticker_symbol})")
                continue
                
            file_path = os.path.join(OUTPUT_DIR, f"{name.lower()}.csv")
            df.to_csv(file_path)
            print(f"Successfully saved {name} data to {file_path}")
            
        except Exception as e:
            print(f"Error fetching data for {name}: {e}")

if __name__ == "__main__":
    fetch_data()
    print("\nData fetch completed.")
