
import pandas as pd
import numpy as np

def clean_df(file_path):
    df = pd.read_csv(file_path, sep=';')
    df = df.dropna(subset=['Bot', 'PnL_Net'])
    df['Bot'] = df['Bot'].astype(str).str.strip()
    df['PnL_Net'] = df['PnL_Net'].astype(str).str.replace(',', '.').replace('nan', '0').astype(float)
    df['Score'] = pd.to_numeric(df['Score'].astype(str).str.replace(',', '.'), errors='coerce')
    return df

def get_scoring_stats(df, phase_name):
    bots = ['DEGEN', 'DISCOVERY']
    results = []
    
    # Define score bins
    bins = [0, 80, 85, 90, 100]
    labels = ['<80', '80-85', '85-90', '>90']
    df['Score_Range'] = pd.cut(df['Score'], bins=bins, labels=labels)

    for bot in bots:
        bot_df = df[df['Bot'] == bot]
        if bot_df.empty:
            continue
        
        # Win Rate per Score Range
        for label in labels:
            range_df = bot_df[bot_df['Score_Range'] == label]
            if range_df.empty:
                continue
            
            wins = range_df[range_df['Exit_Raison'].isin(['TP', 'TP1 & TP2 Touchés', 'TP1 Touché', 'TPDe', 'TP Unique touché'])].shape[0]
            total_valid = range_df[range_df['Exit_Raison'].isin(['TP', 'SL', 'BE', 'TPDe', 'SLDe', 'TP Unique touché', 'Time Limit'])].shape[0]
            win_rate = (wins / total_valid * 100) if total_valid > 0 else 0
            pnl_sum = range_df['PnL_Net'].sum()
            
            results.append({
                'Phase': phase_name,
                'Bot': bot,
                'Score_Range': label,
                'Win Rate': round(win_rate, 2),
                'PnL Sum': round(pnl_sum, 2),
                'Count': range_df.shape[0]
            })
            
    return results

# Files
path_p2 = '/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase2/Sheet 1-Suivi_Trades_Phase2.csv'
path_p3 = '/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase3/Suivi_Trades_Phase3.csv'

df2 = clean_df(path_p2)
df3 = clean_df(path_p3)

stats2 = get_scoring_stats(df2, 'Phase 2')
stats3 = get_scoring_stats(df3, 'Phase 3')

scoring_df = pd.DataFrame(stats2 + stats3)

print("=== EFFACITÉ DU SCORING : WIN RATE % ET PNL PAR TRANCHE ===")
print(scoring_df.to_string(index=False))

# Calculate global reliability improvement
print("\n=== EVOLUTION DE LA FIABILITÉ DU SCORE (WR) ===")
for bot in ['DEGEN', 'DISCOVERY']:
    print(f"\n[{bot}]")
    for label in ['80-85', '85-90', '>90']:
        s2 = next((item for item in stats2 if item["Bot"] == bot and item["Score_Range"] == label), None)
        s3 = next((item for item in stats3 if item["Bot"] == bot and item["Score_Range"] == label), None)
        
        wr2 = s2['Win Rate'] if s2 else "N/A"
        wr3 = s3['Win Rate'] if s3 else "N/A"
        
        if wr2 != "N/A" and wr3 != "N/A":
            diff = wr3 - wr2
            print(f"Tranche {label}: {wr2}% -> {wr3}% ({diff:+.2f}%)")
        else:
            print(f"Tranche {label}: {wr2}% -> {wr3}%")
