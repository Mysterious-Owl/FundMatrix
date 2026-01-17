import yfinance as yf
import os
import pandas as pd
from datetime import datetime

# CONFIGURATION
OUTPUT_DIR = 'indices'
INDICES_METADATA = 'data/indices.csv'

def get_tickers(only_important=True):
    """Reads indices.csv and returns tickers based on criteria."""
    if not os.path.exists(INDICES_METADATA):
        print(f"Error: {INDICES_METADATA} not found.")
        return pd.DataFrame()

    df = pd.read_csv(INDICES_METADATA)
    if only_important:
        return df[df['Importance'] == 'important']
    return df

def fetch_data():
    """Fetches data for indices and commodities with simple date handling and deduplication."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    tickers_df = get_tickers()
    
    if tickers_df.empty:
        print("No tickers found to fetch.")
        return

    print(f"Starting fetch at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}...")
    
    for _, row in tickers_df.iterrows():
        name = str(row['Name']).replace(' ', '_').replace('&', 'and').lower()
        ticker_symbol = row['Ticker']
        file_path = os.path.join(OUTPUT_DIR, f"{name}.csv")
        
        print(f"Processing {row['Name']} ({ticker_symbol})...")
        
        existing_df = pd.DataFrame()
        start_date = None
        
        if os.path.exists(file_path):
            try:
                # Read, ensure Date is naive date script
                existing_df = pd.read_csv(file_path)
                if not existing_df.empty:
                    existing_df['Date'] = pd.to_datetime(existing_df['Date']).dt.date
                    last_date = existing_df['Date'].max()
                    start_date = last_date.strftime('%Y-%m-%d')
                    print(f"  Existing data found up to {last_date}. Fetching from {start_date}")
            except Exception as e:
                print(f"  Error reading existing file {file_path}: {e}")

        try:
            ticker = yf.Ticker(ticker_symbol)
            df = pd.DataFrame()
            
            if start_date:
                df = ticker.history(start=start_date)
            else:
                try:
                    df = ticker.history(period="max")
                except Exception:
                    df = ticker.history(period="10y")
                
                if df.empty:
                    df = ticker.history(period="5y")

            if df.empty:
                print(f"  No new data found for {ticker_symbol}")
                # Save sanitized existing data back to ensure format is clean
                if not existing_df.empty:
                    existing_df.to_csv(file_path, index=False)
                continue
                
            # Clean and prepare new data
            df = df.drop(columns=['Dividends', 'Stock Splits'], errors='ignore')
            df = df.reset_index()
            
            # Convert new data Date to naive date
            df['Date'] = pd.to_datetime(df['Date']).dt.date
            
            # Deduplication and merging
            if not existing_df.empty:
                combined_df = pd.concat([existing_df, df], ignore_index=True)
                combined_df = combined_df.drop_duplicates(subset=['Date'], keep='last')
                combined_df = combined_df.sort_values('Date')
                combined_df.to_csv(file_path, index=False)
                print(f"  Updated {file_path} (Total rows: {len(combined_df)})")
            else:
                df.to_csv(file_path, index=False)
                print(f"  Saved {len(df)} rows to {file_path}")
            
        except Exception as e:
            print(f"  Error fetching data for {ticker_symbol}: {e}")

if __name__ == "__main__":
    fetch_data()
    print("\nFetch completed.")
