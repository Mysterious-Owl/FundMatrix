import pandas as pd
import json
import numpy as np
from datetime import datetime, timedelta
import os

try:
    from pyxirr import xirr
except ImportError:
    xirr = None

def calculate_analytics(gains_csv, realized_csv, nav_history_csv, props_csv):
    if not os.path.exists(gains_csv):
        return None
    
    # 1. LOAD DATA
    unified_df = pd.read_csv(gains_csv) # mf_gains_v2.csv
    if 'isin' in unified_df.columns and 'ISIN' in unified_df.columns:
        unified_df = unified_df.loc[:, ~unified_df.columns.duplicated()]
        if 'isin' in unified_df.columns: unified_df = unified_df.drop(columns=['isin'])
    unified_df['Date'] = pd.to_datetime(unified_df['Date'], format='mixed')

    cams_path = 'data/cams_mf.csv'
    cams_df = pd.read_csv(cams_path)
    cams_df['Date'] = pd.to_datetime(cams_df['Date'], dayfirst=True, format='mixed')
    
    realized_df = pd.DataFrame()
    if os.path.exists(realized_csv):
        realized_df = pd.read_csv(realized_csv)
        realized_df['Buy Date'] = pd.to_datetime(realized_df['Buy Date'])
        realized_df['Sell Date'] = pd.to_datetime(realized_df['Sell Date'])
    
    nav_history = pd.DataFrame()
    if os.path.exists(nav_history_csv):
        nav_history = pd.read_csv(nav_history_csv)
        nav_history['date'] = pd.to_datetime(nav_history['date'])

    props_map = {}
    if os.path.exists(props_csv):
        try:
            p_df = pd.read_csv(props_csv)
            # Store full info in props_map
            for _, p_row in p_df.iterrows():
                props_map[p_row['ISIN']] = {
                    'Type': p_row['Type'],
                    'Sector': p_row.get('Sector', 'Others'),
                    'Cap': p_row.get('Cap', 'Others')
                }
        except Exception as e:
            print(f"Error loading props: {e}")

    def categorize(isin, name):
        if isin in props_map: return props_map[isin]['Type']
        n = str(name).lower()
        # Default logic for auto-categorization
        cat = 'Equity'
        if any(x in n for x in ['liquid', 'overnight', 'money manager']): cat = 'Debt'
        elif 'gold' in n: cat = 'Commodity'
        elif any(x in n for x in ['arbitrage', 'balance', 'hybrid', 'dynamic']): cat = 'Hybrid'
        return cat

    def get_mf_prop(isin, prop_name):
        if isin in props_map: return props_map[isin].get(prop_name, 'Others')
        return 'Others'

    # Identify missing ISINs
    all_isins = cams_df[['ISIN', 'Name']].drop_duplicates()
    new_props = []
    updated = False
    for _, row in all_isins.iterrows():
        isin = row['ISIN']
        if isin not in props_map:
            cat = categorize(isin, row['Name'])
            # Initial defaults for new funds
            props_map[isin] = {'Type': cat, 'Sector': 'Others', 'Cap': 'Others'}
            new_props.append({'Name': row['Name'], 'ISIN': isin, 'Type': cat, 'Sector': 'Others', 'Cap': 'Others'})
            updated = True
    
    if updated and os.path.exists(props_csv):
        try:
            old_props = pd.read_csv(props_csv)
            new_df = pd.DataFrame(new_props)
            combined_props = pd.concat([old_props, new_df], ignore_index=True).drop_duplicates(subset=['ISIN'])
            combined_props.to_csv(props_csv, index=False)
            print(f"Auto-discovered {len(new_props)} new funds and updated {props_csv}")
        except Exception as e:
            print(f"Failed to auto-update mf-props: {e}")

    unified_df['Category'] = unified_df.apply(lambda x: categorize(x['ISIN'], x['Fund Name']), axis=1)

    # --- ACTIVITY STATE ---
    now = datetime.now()
    inv_events_all = cams_df[~cams_df['Investment Type'].str.contains('Redemption|Switch Out|Withdrawal', case=False, na=False)]
    last_inv = inv_events_all.groupby('ISIN')['Date'].max()
    
    def get_activity_state(isin):
        if isin not in last_inv: return 'Closed'
        lid = last_inv[isin]
        days = (now - lid).days
        if days <= 90: return 'Active'
        if days <= 180: return 'Recent'
        return 'Closed'

    # --- SCHEME LIST ---
    scheme_agg = unified_df.groupby(['ISIN', 'Fund Name', 'Category', 'AMC']).agg({
        'invested_val': 'sum', 'current_val': 'sum', 'unrealized_gain': 'sum', 'Units': 'sum', 'units_left': 'sum'
    }).reset_index()

    stcg_unreal = unified_df[unified_df['gain_type'] == 'STCG'].groupby('ISIN')['unrealized_gain'].sum().to_dict()
    ltcg_unreal = unified_df[unified_df['gain_type'] == 'LTCG'].groupby('ISIN')['unrealized_gain'].sum().to_dict()
    ltcg_units = unified_df[unified_df['gain_type'] == 'LTCG'].groupby('ISIN')['units_left'].sum().to_dict()
    today = datetime.now()
    if today.month < 4:
        curr_fy_start = datetime(today.year - 1, 4, 1)
        last_fy_start = datetime(today.year - 2, 4, 1)
        last_fy_end = datetime(today.year - 1, 3, 31)
    else:
        curr_fy_start = datetime(today.year, 4, 1)
        last_fy_start = datetime(today.year - 1, 4, 1)
        last_fy_end = datetime(today.year, 3, 31)

    net_inv_map = cams_df.groupby('ISIN')['Amount'].sum().to_dict()
    real_st = realized_df[realized_df['Type'] == 'STCG'].groupby('ISIN')['Gain'].sum().to_dict() if not realized_df.empty else {}
    real_lt = realized_df[realized_df['Type'] == 'LTCG'].groupby('ISIN')['Gain'].sum().to_dict() if not realized_df.empty else {}
    
    realized_summary = {}
    if not realized_df.empty:
        # Group by ISIN and calculate everything
        for isin, group in realized_df.groupby('ISIN'):
            res = {'realized_gain': group['Gain'].sum(), 'stcg': 0, 'ltcg': 0,
                   'stcg_curr': 0, 'ltcg_curr': 0, 'stcg_last': 0, 'ltcg_last': 0}
            
            res['stcg'] = group[group['Type'] == 'STCG']['Gain'].sum()
            res['ltcg'] = group[group['Type'] == 'LTCG']['Gain'].sum()
            
            curr_fy = group[group['Sell Date'] >= curr_fy_start]
            res['stcg_curr'] = curr_fy[curr_fy['Type'] == 'STCG']['Gain'].sum()
            res['ltcg_curr'] = curr_fy[curr_fy['Type'] == 'LTCG']['Gain'].sum()
            
            last_fy = group[(group['Sell Date'] >= last_fy_start) & (group['Sell Date'] <= last_fy_end)]
            res['stcg_last'] = last_fy[last_fy['Type'] == 'STCG']['Gain'].sum()
            res['ltcg_last'] = last_fy[last_fy['Type'] == 'LTCG']['Gain'].sum()
            
            realized_summary[isin] = {k: round(v, 2) for k, v in res.items()}

    scheme_list = []
    for _, r in scheme_agg.iterrows():
        isin = r['ISIN']
        ni = net_inv_map.get(isin, r['invested_val'])
        
        detail = r.to_dict()
        detail['invested_val'] = round(ni, 2)
        detail['current_val'] = round(r['current_val'], 2)
        detail['units'] = round(r['Units'], 4)
        detail['lt_units'] = round(ltcg_units.get(isin, 0), 4)
        detail['unrealized_gain'] = round(r['unrealized_gain'], 2)
        detail['unrealized_stcg'] = round(stcg_unreal.get(isin, 0), 2)
        detail['unrealized_ltcg'] = round(ltcg_unreal.get(isin, 0), 2)
        
        rs = realized_summary.get(isin, {})
        detail['realized_stcg'] = rs.get('stcg', 0)
        detail['realized_ltcg'] = rs.get('ltcg', 0)
        detail['realized_stcg_curr'] = rs.get('stcg_curr', 0)
        detail['realized_ltcg_curr'] = rs.get('ltcg_curr', 0)
        detail['realized_stcg_last'] = rs.get('stcg_last', 0)
        detail['realized_ltcg_last'] = rs.get('ltcg_last', 0)
        
        total_profit = detail['unrealized_gain'] + rs.get('realized_gain', 0)
        detail['total_profit'] = round(total_profit, 2)
        detail['abs_return'] = round((total_profit / ni * 100) if ni > 0 else 0, 4)
        
        detail['ActivityState'] = get_activity_state(isin)
        detail['Sector'] = get_mf_prop(isin, 'Sector')
        detail['Cap'] = get_mf_prop(isin, 'Cap')
        
        scheme_list.append(detail)

    # --- CASH FLOWS (XIRR) ---
    cash_flows = []
    for _, row in cams_df.iterrows():
        if row['Amount'] != 0:
            cash_flows.append({
                'date': row['Date'].strftime('%Y-%m-%d'), 'amount': -float(row['Amount']),
                'category': categorize(row['ISIN'], row['Name']), 'isin': row['ISIN'], 'fund': row['Name']
            })
    for _, row in scheme_agg.iterrows():
        if row['current_val'] > 0:
            cash_flows.append({
                'date': now.strftime('%Y-%m-%d'), 'amount': float(row['current_val']),
                'category': row['Category'], 'isin': row['ISIN'], 'fund': row['Fund Name']
            })

    # --- INVESTMENT SUMMARY ---
    # Unified filter mapping
    isin_meta = {s['ISIN']: {'ActivityState': s['ActivityState'], 'Sector': s['Sector'], 'Cap': s['Cap']} for s in scheme_list}
    unified_df['ActivityState'] = unified_df['ISIN'].map(lambda x: isin_meta.get(x, {}).get('ActivityState', 'Others'))
    unified_df['Sector'] = unified_df['ISIN'].map(lambda x: isin_meta.get(x, {}).get('Sector', 'Others'))
    unified_df['Cap'] = unified_df['ISIN'].map(lambda x: isin_meta.get(x, {}).get('Cap', 'Others'))
    
    unified_df['MonthName'] = unified_df['Date'].dt.strftime('%b')
    unified_df['Year'] = unified_df['Date'].dt.year
    unified_df['DateKey'] = unified_df['Date'].dt.strftime('%Y-%m')
    inv_pivot = unified_df.groupby(['ISIN', 'Fund Name', 'Category', 'ActivityState', 'AMC', 'Sector', 'Cap', 'Year', 'MonthName', 'DateKey'])['Amount'].sum().reset_index()
    inv_pivot.rename(columns={'MonthName': 'Month'}, inplace=True)
    
    m_keys = sorted(unified_df['DateKey'].unique().tolist())
    monthly_investment_data = { "pivot": inv_pivot.to_dict('records'), "totals": [], "months": m_keys }

    # --- ROLLING RETURNS & PERFORMANCE COMPARISON ---
    rolling_stats = {}
    perf_comparison = []
    
    if not nav_history.empty:
        n_piv = nav_history.pivot_table(index='date', columns='isin', values='nav').sort_index().ffill()
        
        for scheme in scheme_list:
            isin = scheme['ISIN']
            if isin not in n_piv.columns: continue
            
            s_nav = n_piv[isin].dropna()
            if len(s_nav) < 30: continue # Skip if too little data
            
            # 1. Point-to-Point Fund Return (CAGR) since user's first investment
            first_inv_date = cams_df[cams_df['ISIN'] == isin]['Date'].min()
            start_nav_row = s_nav[s_nav.index >= first_inv_date]
            if not start_nav_row.empty:
                start_nav = start_nav_row.iloc[0]
                end_nav = s_nav.iloc[-1]
                years = (s_nav.index[-1] - first_inv_date).days / 365.25
                if years > 0.1:
                    fund_cagr = ((end_nav / start_nav) ** (1/years) - 1) * 100
                    perf_comparison.append({
                        'fund': scheme['Fund Name'],
                        'isin': isin,
                        'category': scheme['Category'],
                        'investor_xirr': 0, # Will be calculated/placeholder for JS
                        'fund_cagr': round(fund_cagr, 2),
                        'years': round(years, 2)
                    })

            # 2. Rolling Returns (1Y, 3Y, 5Y)
            # We use windows of 252, 756, 1260 roughly for daily data
            stats = {}
            for label, days in [('1Y', 365), ('3Y', 1095), ('5Y', 1825)]:
                # Use date offsetting for precise rolling returns
                roll_vals = []
                for i in range(len(s_nav)-1, -1, -1):
                    d_end = s_nav.index[i]
                    d_start = d_end - timedelta(days=days)
                    # Find closest nav to d_start within 5 days
                    s_nav_slice = s_nav[(s_nav.index >= d_start - timedelta(days=5)) & (s_nav.index <= d_start)]
                    if not s_nav_slice.empty:
                        nav_start = s_nav_slice.iloc[-1]
                        nav_end = s_nav.iloc[i]
                        ret = ((nav_end / nav_start) ** (365/days) - 1) * 100
                        roll_vals.append(ret)
                    if len(roll_vals) > 500: break # Limit history for speed
                
                if len(roll_vals) > 20:
                    stats[label] = {
                        'mean': round(float(np.mean(roll_vals)), 2),
                        'median': round(float(np.median(roll_vals)), 2),
                        'min': round(float(np.min(roll_vals)), 2),
                        'max': round(float(np.max(roll_vals)), 2),
                        'latest': round(roll_vals[0], 2)
                    }
            if stats: rolling_stats[isin] = stats

    # --- GROWTH CHART ---
    growth_chart = []
    if not nav_history.empty:
        p_ev = cams_df[~cams_df['Investment Type'].str.contains('Redemption|Switch Out', case=False, na=False)].copy()
        p_ev['Cost'] = p_ev['Units'] * p_ev['Price']
        s_ev = pd.DataFrame()
        if not realized_df.empty:
            s_ev = pd.DataFrame({'Date': realized_df['Sell Date'], 'ISIN': realized_df['ISIN'], 'Units': -realized_df['Units'], 'Cost': -(realized_df['Units'] * realized_df['Buy Price'])})
        all_ev = pd.concat([p_ev[['Date', 'ISIN', 'Units', 'Cost']], s_ev]).sort_values('Date')
        u_piv = all_ev.pivot_table(index='Date', columns='ISIN', values='Units', aggfunc='sum').fillna(0).cumsum()
        i_cum = all_ev.groupby('Date')['Cost'].sum().cumsum()
        n_piv = nav_history.pivot_table(index='date', columns='isin', values='nav').sort_index().ffill()
        f_idx = pd.date_range(all_ev['Date'].min(), now, freq='D')
        if f_idx[-1] < now:
            f_idx = f_idx.union([pd.Timestamp(now)])
        # Prepare ISIN to Category mapping for easier sum in JS
        isin_to_cat = {s['ISIN']: s['Category'] for s in scheme_list}
        
        for d in f_idx:
            # Net cost and cumulative units up to date d
            inv_row = i_cum[i_cum.index <= d]
            inv_val = inv_row.iloc[-1] if not inv_row.empty else 0
            
            u_d = u_piv[u_piv.index <= d].iloc[-1] if not u_piv[u_piv.index <= d].empty else pd.Series()
            n_d = n_piv[n_piv.index <= d].iloc[-1] if not n_piv[n_piv.index <= d].empty else pd.Series()
            
            if not u_d.empty and not n_d.empty:
                com = u_d.index.intersection(n_d.index)
                # We need per-isin values for dynamic frontend filtering
                breakdown = {}
                # Also get per-isin cost up to date d
                c_d = all_ev[all_ev['Date'] <= d].groupby('ISIN')['Cost'].sum()
                
                for isin in com:
                    units = u_d[isin]
                    nav = n_d[isin]
                    cost = c_d.get(isin, 0)
                    
                    # Handle NaN values to prevent invalid JSON
                    safe_nav = float(nav) if pd.notnull(nav) else 0.0
                    safe_cost = float(cost) if pd.notnull(cost) else 0.0
                    safe_units = float(units) if pd.notnull(units) else 0.0
                    
                    val = safe_units * safe_nav
                    
                    if safe_units > 0 or abs(safe_cost) > 0:
                        breakdown[isin] = {
                            'v': round(val, 2),
                            'i': round(safe_cost, 2),
                            'c': isin_to_cat.get(isin, 'Unknown')
                        }
                if breakdown:
                    growth_chart.append({
                        'date': d.strftime('%Y-%m-%d'),
                        'b': breakdown # 'b' for breakdown to save space
                    })

    # Final Summary Stats
    cur_val = scheme_agg['current_val'].sum()
    inv_val = cams_df['Amount'].sum() # Net Capital Inflow
    total_unreal = scheme_agg['unrealized_gain'].sum()
    total_real = sum(real_st.values()) + sum(real_lt.values()) if (real_st or real_lt) else 0

    dashboard_data = {
        "summary": { "current_value": round(cur_val, 2), "total_invested": round(inv_val, 2), "realized_gain": round(total_real, 2), "unrealized_gain": round(total_unreal, 2), "total_profit": round(total_unreal + total_real, 2) },
        "investment_summary": monthly_investment_data,
        "allocations": { "amc": unified_df[unified_df['units_left'] > 0].groupby('AMC')['current_val'].sum().sort_values(ascending=False).to_dict(), "category": unified_df[unified_df['units_left'] > 0].groupby('Category')['current_val'].sum().sort_values(ascending=False).to_dict() },
        "growth_chart": growth_chart, "scheme_details": scheme_list, 
        "categories": sorted(unified_df['Category'].unique().tolist()), 
        "amcs": sorted(unified_df['AMC'].unique().tolist()),
        "sectors": sorted(list(set(s['Sector'] for s in scheme_list))),
        "caps": sorted(list(set(s['Cap'] for s in scheme_list))),
        "activity_states": ["Active", "Recent", "Closed"],
        "cash_flows": cash_flows, "transition_planning": [],
        "rolling_stats": rolling_stats,
        "performance_comparison": perf_comparison,
        "gains_breakdown": { 
            "unrealized": { "stcg": round(unified_df[unified_df['gain_type'] == 'STCG']['unrealized_gain'].sum(), 2), "ltcg": round(unified_df[unified_df['gain_type'] == 'LTCG']['unrealized_gain'].sum(), 2) },
            "realized": { "stcg": round(sum(real_st.values()) if real_st else 0, 2), "ltcg": round(sum(real_lt.values()) if real_lt else 0, 2) }
        },
        "data_stats": {
            "last_file_date": "N/A",
            "last_txn_date": cams_df['Date'].max().strftime('%Y-%m-%d') if not cams_df.empty else "N/A",
            "last_nav_date": nav_history['date'].max().strftime('%Y-%m-%d') if not nav_history.empty else "N/A"
        },
        "last_updated": now.strftime('%Y-%m-%d %H:%M:%S')
    }
    
    # Calculate last file date in cas_pdf
    try:
        pdf_files = [os.path.join('cas_pdf', f) for f in os.listdir('cas_pdf') if f.lower().endswith('.pdf')]
        if pdf_files:
            latest_file = max(pdf_files, key=os.path.getmtime)
            dashboard_data["data_stats"]["last_file_date"] = datetime.fromtimestamp(os.path.getmtime(latest_file)).strftime('%Y-%m-%d %H:%M:%S')
    except: pass
    
    # Rest of transitions and realized breakdown
    real_st_sum = realized_df[realized_df['Type'] == 'STCG']['Gain'].sum() if not realized_df.empty else 0
    real_lt_sum = realized_df[realized_df['Type'] == 'LTCG']['Gain'].sum() if not realized_df.empty else 0
    
    dashboard_data["gains_breakdown"]["realized"] = {"stcg": round(real_st_sum, 2), "ltcg": round(real_lt_sum, 2)}

    # FY Breakdown for Realized Gains
    realized_fy = {
        "ALL": {"stcg": round(real_st_sum, 2), "ltcg": round(real_lt_sum, 2)},
        "CURRENT": {"stcg": 0, "ltcg": 0},
        "LAST": {"stcg": 0, "ltcg": 0}
    }

    if not realized_df.empty:
        c_fy = realized_df[realized_df['Sell Date'] >= curr_fy_start]
        realized_fy["CURRENT"]["stcg"] = round(c_fy[c_fy['Type'] == 'STCG']['Gain'].sum(), 2)
        realized_fy["CURRENT"]["ltcg"] = round(c_fy[c_fy['Type'] == 'LTCG']['Gain'].sum(), 2)
        
        l_fy = realized_df[(realized_df['Sell Date'] >= last_fy_start) & (realized_df['Sell Date'] <= last_fy_end)]
        realized_fy["LAST"]["stcg"] = round(l_fy[l_fy['Type'] == 'STCG']['Gain'].sum(), 2)
        realized_fy["LAST"]["ltcg"] = round(l_fy[l_fy['Type'] == 'LTCG']['Gain'].sum(), 2)

    dashboard_data["gains_breakdown"]["realized_fy"] = realized_fy

    # Transition Planning
    st_lots = unified_df[unified_df['gain_type'] == 'STCG'].copy()
    for _, l in st_lots.iterrows():
        dl = 365 - (now - l['Date']).days
        if 0 < dl <= 90:
            isin = l['ISIN']
            meta = isin_meta.get(isin, {})
            dashboard_data["transition_planning"].append({
                'ISIN': isin,
                'scheme': l['Fund Name'],
                'units': round(l['units_left'], 4),
                'gain': round(l['unrealized_gain'], 2),
                'days_left': dl,
                'date': l['Date'].strftime('%Y-%m-%d'),
                'Category': l['Category'],
                'AMC': l['AMC'],
                'Sector': meta.get('Sector', 'Others'),
                'Cap': meta.get('Cap', 'Others'),
                'ActivityState': meta.get('ActivityState', 'Others')
            })
    dashboard_data["transition_planning"].sort(key=lambda x: x['days_left'])

    return dashboard_data

if __name__ == "__main__":
    data = calculate_analytics('data/mf_gains_v2.csv', 'data/realized_gains.csv', 'data/full_nav_history.csv', 'data/mf-props.csv')
    if data:
        with open('data/dashboard_data.json', 'w') as f: json.dump(data, f, indent=4)
        print("Analytics processed successfully.")
