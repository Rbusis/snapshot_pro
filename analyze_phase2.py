import pandas as pd
import numpy as np

def parse_decimal(val):
    if isinstance(val, str):
        return float(val.replace(',', '.'))
    return val

def analyze():
    file_path = "/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase2/Sheet 1-Suivi_Trades_Phase2.csv"
    
    # Read CSV
    df = pd.read_csv(file_path, sep=';', encoding='utf-8')
    
    # Parse PnL and Prices
    df['PnL_Net'] = df['PnL_Net'].apply(parse_decimal)
    df['Entry_Prix'] = df['Entry_Prix'].apply(parse_decimal)
    df['Exit_Prix'] = df['Exit_Prix'].apply(parse_decimal)
    
    # Cleanup Bot names (remove trailing spaces or weird chars if any)
    df['Bot'] = df['Bot'].str.strip()
    
    print("="*60)
    print("PHASE 2 TRADING PERFORMANCE REPORT")
    print("="*60)
    
    # 1. GLOBAL PERFORMANCE
    total_pnl = df['PnL_Net'].sum()
    win_count = len(df[df['Exit_Raison'] == 'TP'])
    loss_count = len(df[df['Exit_Raison'] == 'SL'])
    be_count = len(df[df['Exit_Raison'] == 'BE'])
    time_limit_count = len(df[df['Exit_Raison'] == 'Time Limit'])
    
    win_rate = (win_count / (win_count + loss_count)) * 100 if (win_count + loss_count) > 0 else 0
    adj_win_rate = ((win_count + be_count) / len(df)) * 100 if len(df) > 0 else 0
    
    print(f"Total Trades: {len(df)}")
    print(f"Total PnL: {total_pnl:.4f} USDT")
    print(f"Classic Win Rate (TP/SL): {win_rate:.2f}%")
    print(f"Safety Win Rate (TP+BE/Total): {adj_win_rate:.2f}%")
    print(f"Breakdown: TP: {win_count}, SL: {loss_count}, BE: {be_count}, Time Limit: {time_limit_count}")
    print("-"*60)
    
    # 2. ANALYSIS BY DIRECTION (LONG/SHORT)
    print("\nPERFORMANCE BY DIRECTION")
    direction_metrics = df.groupby('Direction').agg({
        'PnL_Net': 'sum',
        'Direction': 'count'
    }).rename(columns={'Direction': 'Count'})
    
    for direction, row in direction_metrics.iterrows():
        dir_df = df[df['Direction'] == direction]
        d_win = len(dir_df[dir_df['Exit_Raison'] == 'TP'])
        d_loss = len(dir_df[dir_df['Exit_Raison'] == 'SL'])
        d_wr = (d_win / (d_win + d_loss)) * 100 if (d_win + d_loss) > 0 else 0
        print(f"{direction:6}: {row['Count']} trades | PnL: {row['PnL_Net']:>8.4f} | Win Rate: {d_wr:>6.2f}%")
    print("-"*60)
    
    # 3. ANALYSIS BY BOT
    print("\nPERFORMANCE BY BOT")
    bot_metrics = df.groupby('Bot').agg({
        'PnL_Net': 'sum',
        'Bot': 'count'
    }).rename(columns={'Bot': 'Count'})
    
    for bot, row in bot_metrics.iterrows():
        b_df = df[df['Bot'] == bot]
        b_win = len(b_df[b_df['Exit_Raison'] == 'TP'])
        b_loss = len(b_df[b_df['Exit_Raison'] == 'SL'])
        b_wr = (b_win / (b_win + b_loss)) * 100 if (b_win + b_loss) > 0 else 0
        print(f"{bot:12}: {row['Count']} trades | PnL: {row['PnL_Net']:>8.4f} | Win Rate: {b_wr:>6.2f}%")
    print("-"*60)
    
    # 4. BOT + DIRECTION
    print("\nPERFORMANCE BY BOT + DIRECTION")
    bot_dir = df.groupby(['Bot', 'Direction']).agg({
        'PnL_Net': 'sum',
        'Symbol': 'count'
    }).rename(columns={'Symbol': 'Count'})
    print(bot_dir)
    print("-"*60)
    
    # 5. BE ANALYSIS (WHAT IF)
    print("\nBREAK-EVEN ANALYSIS (Notes 2 Audit)")
    be_trades = df[df['Exit_Raison'] == 'BE']
    tp_if_waited = 0
    sl_if_waited = 0
    still_active = 0
    
    for idx, row in be_trades.iterrows():
        note = str(row['Notes 2']).lower()
        if 'range' in note or 'actuellement' in note:
            still_active += 1
        elif 'tp' in note:
            tp_if_waited += 1
        elif 'sl' in note:
            sl_if_waited += 1
            
    print(f"BE Trades Count: {len(be_trades)}")
    print(f" - Would have hit TP: {tp_if_waited}")
    print(f" - Would have hit SL: {sl_if_waited}")
    print(f" - Still active/Range: {still_active}")
    print(f"Conclusion: Closing at BE saved {sl_if_waited} full losses but missed {tp_if_waited} full wins.")
    print("-"*60)
    
    # 6. NEGATIVE BE AUDIT
    print("\nAUDIT: NEGATIVE BREAK-EVENS (To Correct)")
    neg_be = df[(df['Exit_Raison'] == 'BE') & (df['PnL_Net'] < 0)]
    if len(neg_be) > 0:
        for idx, row in neg_be.iterrows():
            print(f"Row {idx+2}: {row['Symbol']} ({row['Bot']}) | PnL: {row['PnL_Net']}")
    else:
        print("No negative BE trades found! (Everything >= 0)")
    print("="*60)

if __name__ == "__main__":
    analyze()
