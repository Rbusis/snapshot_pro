
import pandas as pd

def clean_df(file_path):
    df = pd.read_csv(file_path, sep=';')
    df = df.dropna(subset=['Bot', 'PnL_Net'])
    df['Bot'] = df['Bot'].astype(str).str.strip()
    df['PnL_Net'] = df['PnL_Net'].astype(str).str.replace(',', '.').replace('nan', '0').astype(float)
    return df

def get_stats(df, phase_name):
    bots = ['DEGEN', 'DISCOVERY']
    results = []
    for bot in bots:
        bot_df = df[df['Bot'] == bot]
        if bot_df.empty:
            continue
        
        pnl_sum = bot_df['PnL_Net'].sum()
        pnl_mean = bot_df['PnL_Net'].mean()
        trade_count = bot_df.shape[0]
        
        wins = bot_df[bot_df['Exit_Raison'].isin(['TP', 'TP1 & TP2 Touchés', 'TP1 Touché', 'TPDe', 'TP Unique touché'])].shape[0]
        total_valid = bot_df[bot_df['Exit_Raison'].isin(['TP', 'SL', 'BE', 'TPDe', 'SLDe', 'TP Unique touché', 'Time Limit'])].shape[0]
        win_rate = (wins / total_valid * 100) if total_valid > 0 else 0
        
        results.append({
            'Phase': phase_name,
            'Bot': bot,
            'PnL Sum': round(pnl_sum, 2),
            'Win Rate': round(win_rate, 2),
            'Avg PnL': round(pnl_mean, 4),
            'Trades': trade_count
        })
    return results

# Files
path_p2 = '/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase2/Sheet 1-Suivi_Trades_Phase2.csv'
path_p3 = '/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase3/Suivi_Trades_Phase3.csv'

df2 = clean_df(path_p2)
df3 = clean_df(path_p3)

stats2 = get_stats(df2, 'Phase 2')
stats3 = get_stats(df3, 'Phase 3')

comparison_df = pd.DataFrame(stats2 + stats3)
print(comparison_df.to_string(index=False))

print("\n=== EVOLUTION PAR BOT ===")
for bot in ['DEGEN', 'DISCOVERY']:
    b2 = next((item for item in stats2 if item["Bot"] == bot), None)
    b3 = next((item for item in stats3 if item["Bot"] == bot), None)
    if b2 and b3:
        pnl_diff = b3['PnL Sum'] - b2['PnL Sum']
        wr_diff = b3['Win Rate'] - b2['Win Rate']
        print(f"\n[{bot}]")
        print(f"PnL: {b2['PnL Sum']} -> {b3['PnL Sum']} ({pnl_diff:+.2f})")
        print(f"Win Rate: {b2['Win Rate']}% -> {b3['Win Rate']}% ({wr_diff:+.2f}%)")
