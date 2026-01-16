import re
import pandas as pd
import requests
import json
import numpy as np
from datetime import datetime
import os

HISTORY_DIR = r"q:\mf\history_nav"

def get_history_nav(scheme_code, scheme_name, force_refresh=False):
    safe_name = re.sub(r'[^\w\s-]', '', scheme_name).strip().replace(' ', '_')
    file_path = os.path.join(HISTORY_DIR, f"{scheme_code}_{safe_name}.csv")

    try:
        if force_refresh or not os.path.exists(file_path):
            url = f'https://api.mfapi.in/mf/{scheme_code}'
            response = requests.get(url)
            if response.status_code == 200:
                data = json.loads(response.content.decode())
                temp_df = pd.DataFrame(data['data'])
                temp_df['scheme_name'] = data['meta']['scheme_name']
                temp_df['isin'] = data['meta']['isin_growth']
                temp_df.to_csv(file_path, index=False)
                return temp_df
            else:
                return pd.DataFrame()
        else:
            return pd.read_csv(file_path)
    except Exception as e:
        print(f"Error fetching/reading {scheme_code}: {e}")
        return pd.DataFrame()

def process_mf_data(input_csv, output_gains_csv, output_realized_csv, force_refresh=False):
    if not os.path.exists(input_csv):
        print(f"Error: {input_csv} not found.")
        return

    if not os.path.exists(HISTORY_DIR):
        os.makedirs(HISTORY_DIR)

    df = pd.read_csv(input_csv)
    df['Date'] = pd.to_datetime(df['Date'], format='mixed', dayfirst=True)
    df['Fund Name'] = df['Name']

    try:
        all_mf = pd.DataFrame(json.loads(requests.get('https://api.mfapi.in/mf').content.decode()))
        found_mfs = all_mf[all_mf['isinGrowth'].isin(df['ISIN'].unique())]
    except Exception:
        return

    history_df = pd.DataFrame()
    for i, j in found_mfs.iterrows():
        df_scheme = get_history_nav(j['schemeCode'], j['schemeName'], force_refresh=force_refresh)
        if not df_scheme.empty:
            history_df = pd.concat([history_df, df_scheme])

    if history_df.empty: return

    history_df['date'] = history_df['date'].apply(lambda x: '-'.join(x.split('-')[::-1]))
    history_df['date'] = pd.to_datetime(history_df['date'])
    history_df['nav'] = pd.to_numeric(history_df['nav'])
    history_df.sort_values(by=['isin', 'date'], ascending=False, inplace=True)
    
    # Save full combined history for analytics usage
    history_df.to_csv('data/full_nav_history.csv', index=False)

    today_nav_df = history_df.groupby('isin').first().reset_index()
    today_nav_df.columns = ['isin', 'date_last', 'nav_last', 'scheme_name']
    today_nav_df.drop(columns='scheme_name', inplace=True)

    df = df.merge(today_nav_df, left_on=['ISIN'], right_on=['isin'], how='left')

    # FIFO Logic
    red_df = df[df['Investment Type'] == 'Redemption'].copy()
    pur_df = df[df['Investment Type'] != 'Redemption'].copy()
    
    pur_df['units_left'] = pur_df['Units']
    
    red_df.sort_values('Date', inplace=True)
    pur_df.sort_values('Date', inplace=True)
    pur_df.reset_index(drop=True, inplace=True)

    realized_gains = []

    for i, j in red_df.iterrows():
        units_to_redeem = abs(float(j['Units']))
        sell_date = j['Date']
        sell_price = j['Price'] # Redemption Price from statement

        mask = (pur_df['ISIN'] == j['ISIN']) & (pur_df['Date'] <= j['Date']) & (pur_df['units_left'] > 0)
        potential_sales = pur_df[mask].index.to_list()
        
        for idx in potential_sales:
            if units_to_redeem <= 0: break
                
            available = pur_df.loc[idx, 'units_left']
            redeemed = min(available, units_to_redeem)
            
            pur_df.loc[idx, 'units_left'] -= redeemed
            units_to_redeem -= redeemed
            
            # Calculate Realized Gain
            buy_date = pur_df.loc[idx, 'Date']
            buy_price = pur_df.loc[idx, 'Price']
            days_held = (sell_date - buy_date).days
            gain_type = 'LTCG' if days_held > 365 else 'STCG' # Simplified year check
            gain_amount = (sell_price - buy_price) * redeemed
            
            realized_gains.append({
                'Fund Name': j['Fund Name'],
                'ISIN': j['ISIN'],
                'Buy Date': buy_date,
                'Sell Date': sell_date,
                'Units': redeemed,
                'Buy Price': buy_price,
                'Sell Price': sell_price,
                'Gain': gain_amount,
                'Type': gain_type,
                'Days Held': days_held
            })

    # Save Realized Gains
    if realized_gains:
        pd.DataFrame(realized_gains).to_csv(output_realized_csv, index=False)
    else:
        # Create empty if no realized gains
        pd.DataFrame(columns=['Fund Name', 'ISIN', 'Buy Date', 'Sell Date', 'Units', 'Buy Price', 'Sell Price', 'Gain', 'Type', 'Days Held']).to_csv(output_realized_csv, index=False)

    # Save Holding Status (Unrealized)
    pur_df['current_val'] = pur_df['units_left'] * pur_df['nav_last']
    pur_df['invested_val'] = pur_df['units_left'] * pur_df['Price']
    pur_df['unrealized_gain'] = pur_df['current_val'] - pur_df['invested_val']
    pur_df['holding_days'] = (datetime.now() - pur_df['Date']).dt.days
    pur_df['gain_type'] = np.where(pur_df['holding_days'] > 365, 'LTCG', 'STCG')
    
    pur_df.to_csv(output_gains_csv, index=False)
    print("Processing complete.")

if __name__ == "__main__":
    process_mf_data('data/cams_mf.csv', 'data/mf_gains_v2.csv', 'data/realized_gains.csv')
