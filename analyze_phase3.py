
import pandas as pd
import numpy as np

# Load the CSV
file_path = '/Users/raphaelblanchon/Downloads/CFTT/Suivi_Trades_Phase3/Suivi_Trades_Phase3.csv'

# Read with ; separator
df = pd.read_csv(file_path, sep=';')

# Clean columns
df = df.dropna(subset=['Bot', 'PnL_Net'])

# Convert numeric columns
df['PnL_Net'] = df['PnL_Net'].astype(str).str.replace(',', '.').astype(float)
df['Score'] = pd.to_numeric(df['Score'].astype(str).str.replace(',', '.'), errors='coerce')

# Global stats by Bot
stats = df.groupby('Bot').agg({
    'PnL_Net': ['sum', 'mean', 'count'],
    'Score': 'mean'
})

# Win Rate calculation
def calc_win_rate(group):
    wins = group[group['Exit_Raison'].isin(['TP', 'TP1 & TP2 Touchés', 'TP1 Touché', 'TPDe'])].shape[0]
    total = group[group['Exit_Raison'].isin(['TP', 'SL', 'BE', 'TPDe', 'SLDe'])].shape[0]
    return (wins / total * 100) if total > 0 else 0

win_rates = df.groupby('Bot').apply(calc_win_rate)

# Exit Reason distribution
exit_distribution = pd.crosstab(df['Bot'], df['Exit_Raison'])

# Score vs PnL Correlation
correlations = df.groupby('Bot').apply(lambda x: x['Score'].corr(x['PnL_Net']))

print("=== STATS PAR BOT ===")
print(stats)
print("\n=== WIN RATE PAR BOT ===")
print(win_rates)
print("\n=== DISTRIBUTION DES EXITS ===")
print(exit_distribution)
print("\n=== CORRELATION SCORE vs PNL ===")
print(correlations)

# Analyze High Scores vs Low Scores
df['Score_Range'] = pd.cut(df['Score'], bins=[0, 80, 85, 90, 100], labels=['<80', '80-85', '85-90', '>90'])
score_stats = df.groupby(['Bot', 'Score_Range'])['PnL_Net'].agg(['mean', 'sum', 'count'])
print("\n=== STATS PAR TRANCHE DE SCORE ===")
print(score_stats)
