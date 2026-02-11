#!/usr/bin/env python3
"""
Trading Bot Performance Analyzer - Enhanced Version
Analyzes trading results from Bitget futures position history
to evaluate the effectiveness of 4 trading bot strategies.

Enhanced features:
- Break-even trade classification
- Long vs Short analysis
- Time-based patterns
- Detailed improvement recommendations
"""

import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime

# Bot configuration based on position sizes (x2 leverage)
BOT_CONFIGS = {
    'DEGEN': {'bet': 10, 'leverage': 2, 'position_size': 20},
    'DISCOVERY': {'bet': 15, 'leverage': 2, 'position_size': 30},
    'SWING': {'bet': 20, 'leverage': 2, 'position_size': 40},
    'TOP30': {'bet': 25, 'leverage': 2, 'position_size': 50}
}

# Tolerance for position size matching (±15%)
TOLERANCE = 0.15

# Break-even threshold (considers trades within ±0.1 USDT as BE)
BE_THRESHOLD = 0.1

def classify_trade_by_position_size(closed_value):
    """
    Classify a trade to a bot based on the closed value (position size).
    
    Args:
        closed_value: Position size in USDT
        
    Returns:
        Bot name or 'UNKNOWN'
    """
    for bot_name, config in BOT_CONFIGS.items():
        expected_size = config['position_size']
        lower_bound = expected_size * (1 - TOLERANCE)
        upper_bound = expected_size * (1 + TOLERANCE)
        
        if lower_bound <= closed_value <= upper_bound:
            return bot_name
    
    return 'UNKNOWN'

def parse_closed_value(value_str):
    """Parse closed value string to extract numeric USDT amount."""
    if pd.isna(value_str):
        return None
    try:
        return float(value_str.replace('USDT', '').strip())
    except:
        return None

def parse_pnl(pnl_str):
    """Parse PnL string to extract numeric value."""
    if pd.isna(pnl_str):
        return None
    try:
        return float(pnl_str.replace('USDT', '').strip())
    except:
        return None

def extract_direction(futures_str):
    """Extract trade direction (Long/Short) from Futures column."""
    if pd.isna(futures_str):
        return 'UNKNOWN'
    
    futures_str = str(futures_str).upper()
    if 'LONG' in futures_str:
        return 'LONG'
    elif 'SHORT' in futures_str:
        return 'SHORT'
    else:
        return 'UNKNOWN'

def classify_pnl_category(pnl):
    """Classify PnL into WIN/LOSS/BE categories."""
    if abs(pnl) <= BE_THRESHOLD:
        return 'BE'
    elif pnl > 0:
        return 'WIN'
    else:
        return 'LOSS'

def analyze_trading_performance(csv_file):
    """
    Analyze trading performance by bot strategy with enhanced metrics.
    
    Args:
        csv_file: Path to the CSV file with position history
        
    Returns:
        Dictionary with analysis results
    """
    # Read CSV file with semicolon delimiter
    df = pd.read_csv(csv_file, delimiter=';')
    
    # Parse closed value and PnL
    df['Closed_Value_Numeric'] = df['Closed value'].apply(parse_closed_value)
    df['Net_PnL'] = df['Realized PnL'].apply(parse_pnl)
    
    # Extract direction and classify
    df['Direction'] = df['Futures'].apply(extract_direction)
    df['PnL_Category'] = df['Net_PnL'].apply(classify_pnl_category)
    
    # Parse timestamps
    df['Opening_Time'] = pd.to_datetime(df['Opening time'], errors='coerce')
    df['Closing_Time'] = pd.to_datetime(df['Closed time'], errors='coerce')
    
    # Filter out rows with missing data
    df_clean = df[df['Closed_Value_Numeric'].notna() & df['Net_PnL'].notna()].copy()
    
    # Classify each trade by bot
    df_clean['Bot'] = df_clean['Closed_Value_Numeric'].apply(classify_trade_by_position_size)
    
    # Calculate hold time
    df_clean['Hold_Time_Hours'] = (df_clean['Closing_Time'] - df_clean['Opening_Time']).dt.total_seconds() / 3600
    
    # Create results dictionary
    results = {
        'total_trades': len(df_clean),
        'by_bot': {},
        'by_bot_direction': {}
    }
    
    # Analyze each bot
    for bot_name in list(BOT_CONFIGS.keys()) + ['UNKNOWN']:
        bot_trades = df_clean[df_clean['Bot'] == bot_name]
        
        if len(bot_trades) == 0:
            continue
        
        # Overall metrics
        total_pnl = bot_trades['Net_PnL'].sum()
        
        # Classify by PnL category (with BE)
        wins = bot_trades[bot_trades['PnL_Category'] == 'WIN']
        losses = bot_trades[bot_trades['PnL_Category'] == 'LOSS']
        bes = bot_trades[bot_trades['PnL_Category'] == 'BE']
        
        win_count = len(wins)
        loss_count = len(losses)
        be_count = len(bes)
        total_count = len(bot_trades)
        
        # Win rate excluding BE trades
        win_rate_exc_be = (win_count / (win_count + loss_count) * 100) if (win_count + loss_count) > 0 else 0
        
        # Win rate including BE as wins (traditional)
        win_rate_inc_be = ((win_count + be_count) / total_count * 100) if total_count > 0 else 0
        
        avg_win = wins['Net_PnL'].mean() if win_count > 0 else 0
        avg_loss = losses['Net_PnL'].mean() if loss_count > 0 else 0
        avg_pnl = bot_trades['Net_PnL'].mean()
        
        # Profit factor
        total_wins = wins['Net_PnL'].sum() if win_count > 0 else 0
        total_losses = abs(losses['Net_PnL'].sum()) if loss_count > 0 else 0
        profit_factor = (total_wins / total_losses) if total_losses > 0 else float('inf')
        
        # Expectancy (using win rate exc BE)
        expectancy = (win_rate_exc_be/100 * avg_win) + ((1-win_rate_exc_be/100) * avg_loss)
        
        # Long vs Short analysis
        longs = bot_trades[bot_trades['Direction'] == 'LONG']
        shorts = bot_trades[bot_trades['Direction'] == 'SHORT']
        
        long_metrics = analyze_direction_metrics(longs) if len(longs) > 0 else None
        short_metrics = analyze_direction_metrics(shorts) if len(shorts) > 0 else None
        
        results['by_bot'][bot_name] = {
            'total_trades': total_count,
            'winning_trades': win_count,
            'losing_trades': loss_count,
            'be_trades': be_count,
            'win_rate_exc_be': win_rate_exc_be,
            'win_rate_inc_be': win_rate_inc_be,
            'total_pnl': total_pnl,
            'avg_pnl_per_trade': avg_pnl,
            'avg_win': avg_win,
            'avg_loss': avg_loss,
            'profit_factor': profit_factor,
            'expectancy': expectancy,
            'max_win': wins['Net_PnL'].max() if win_count > 0 else 0,
            'max_loss': losses['Net_PnL'].min() if loss_count > 0 else 0,
            'avg_hold_time': bot_trades['Hold_Time_Hours'].mean(),
            'long_metrics': long_metrics,
            'short_metrics': short_metrics,
        }
    
    results['classified_df'] = df_clean
    
    return results

def analyze_direction_metrics(direction_df):
    """Analyze metrics for a specific direction (Long or Short)."""
    if len(direction_df) == 0:
        return None
    
    wins = direction_df[direction_df['PnL_Category'] == 'WIN']
    losses = direction_df[direction_df['PnL_Category'] == 'LOSS']
    bes = direction_df[direction_df['PnL_Category'] == 'BE']
    
    win_count = len(wins)
    loss_count = len(losses)
    be_count = len(bes)
    total = len(direction_df)
    
    win_rate = (win_count / (win_count + loss_count) * 100) if (win_count + loss_count) > 0 else 0
    
    return {
        'total': total,
        'wins': win_count,
        'losses': loss_count,
        'bes': be_count,
        'win_rate': win_rate,
        'total_pnl': direction_df['Net_PnL'].sum(),
        'avg_pnl': direction_df['Net_PnL'].mean(),
        'avg_win': wins['Net_PnL'].mean() if win_count > 0 else 0,
        'avg_loss': losses['Net_PnL'].mean() if loss_count > 0 else 0,
    }

def print_enhanced_report(results):
    """Print enhanced analysis report with BE trades and Long/Short breakdown."""
    print("=" * 90)
    print("TRADING BOT PERFORMANCE ANALYSIS - ENHANCED")
    print("=" * 90)
    print(f"\nTotal Trades Analyzed: {results['total_trades']}")
    print(f"Break-Even Threshold: ±{BE_THRESHOLD} USDT")
    print("\n" + "=" * 90)
    
    # Sort bots by total PnL
    bots_sorted = sorted(
        results['by_bot'].items(),
        key=lambda x: x[1]['total_pnl'],
        reverse=True
    )
    
    for bot_name, m in bots_sorted:
        if bot_name == 'UNKNOWN':
            continue
            
        print(f"\n{'🔥 ' + bot_name + ' BOT':.^90}")
        print(f"Configuration: ${BOT_CONFIGS[bot_name]['bet']} bet, {BOT_CONFIGS[bot_name]['leverage']}x leverage")
        print(f"Expected Position Size: ~${BOT_CONFIGS[bot_name]['position_size']}")
        print("-" * 90)
        
        print(f"📊 Trade Statistics:")
        print(f"   Total Trades:      {m['total_trades']}")
        print(f"   Winning Trades:    {m['winning_trades']} ({m['win_rate_exc_be']:.1f}% WR)")
        print(f"   Losing Trades:     {m['losing_trades']}")
        print(f"   Break-Even Trades: {m['be_trades']} (±{BE_THRESHOLD} USDT)")
        print(f"   Win Rate (exc BE): {m['win_rate_exc_be']:.1f}%")
        print(f"   Win Rate (inc BE): {m['win_rate_inc_be']:.1f}%")
        
        print(f"\n💰 Profitability:")
        print(f"   Total PnL:         {m['total_pnl']:.2f} USDT")
        print(f"   Avg PnL/Trade:     {m['avg_pnl_per_trade']:.2f} USDT")
        print(f"   ROI per Trade:     {(m['avg_pnl_per_trade']/BOT_CONFIGS[bot_name]['bet']*100):.2f}%")
        print(f"   Avg Hold Time:     {m['avg_hold_time']:.1f} hours")
        
        print(f"\n📈 Win/Loss Analysis:")
        print(f"   Average Win:       {m['avg_win']:.2f} USDT")
        print(f"   Average Loss:      {m['avg_loss']:.2f} USDT")
        print(f"   Max Win:           {m['max_win']:.2f} USDT")
        print(f"   Max Loss:          {m['max_loss']:.2f} USDT")
        print(f"   R:R Ratio:         {abs(m['avg_win']/m['avg_loss']) if m['avg_loss'] != 0 else 0:.2f}")
        
        print(f"\n🎯 Performance Metrics:")
        pf_display = f"{m['profit_factor']:.2f}" if m['profit_factor'] != float('inf') else "∞"
        print(f"   Profit Factor:     {pf_display}")
        print(f"   Expectancy:        {m['expectancy']:.2f} USDT")
        
        # Long vs Short analysis
        print(f"\n📍 LONG vs SHORT Breakdown:")
        
        if m['long_metrics']:
            lm = m['long_metrics']
            print(f"   LONG  →  {lm['total']:2d} trades | WR: {lm['win_rate']:5.1f}% | "
                  f"PnL: {lm['total_pnl']:6.2f} | Avg: {lm['avg_pnl']:5.2f}")
            print(f"            Wins:{lm['wins']:2d} | Losses:{lm['losses']:2d} | BE:{lm['bes']:2d}")
        else:
            print(f"   LONG  →  No trades")
        
        if m['short_metrics']:
            sm = m['short_metrics']
            print(f"   SHORT →  {sm['total']:2d} trades | WR: {sm['win_rate']:5.1f}% | "
                  f"PnL: {sm['total_pnl']:6.2f} | Avg: {sm['avg_pnl']:5.2f}")
            print(f"            Wins:{sm['wins']:2d} | Losses:{sm['losses']:2d} | BE:{sm['bes']:2d}")
        else:
            print(f"   SHORT →  No trades")
        
        # Direction preference
        if m['long_metrics'] and m['short_metrics']:
            long_better = m['long_metrics']['avg_pnl'] > m['short_metrics']['avg_pnl']
            better_dir = "LONG" if long_better else "SHORT"
            diff_pnl = abs(m['long_metrics']['total_pnl'] - m['short_metrics']['total_pnl'])
            print(f"   🎯 Better Direction: {better_dir} (+{diff_pnl:.2f} USDT difference)")
    
    # Handle unknown trades
    if 'UNKNOWN' in results['by_bot']:
        m = results['by_bot']['UNKNOWN']
        print(f"\n{'⚠️  UNCLASSIFIED TRADES':.^90}")
        print(f"Total: {m['total_trades']} trades | PnL: {m['total_pnl']:.2f} USDT")
    
    print("\n" + "=" * 90)
    print("RANKING BY PROFITABILITY")
    print("=" * 90)
    
    rank = 1
    for bot_name, m in bots_sorted:
        if bot_name == 'UNKNOWN':
            continue
        
        emoji = "🥇" if rank == 1 else "🥈" if rank == 2 else "🥉" if rank == 3 else f"{rank}."
        print(f"{emoji} {bot_name:12s} | PnL: {m['total_pnl']:8.2f} USDT | "
              f"WR: {m['win_rate_exc_be']:5.1f}% | Trades: {m['total_trades']:3d} | "
              f"BE: {m['be_trades']:2d}")
        rank += 1
    
    print("=" * 90)

def generate_recommendations(results):
    """Generate detailed recommendations based on analysis."""
    print("\n" + "=" * 90)
    print("💡 RECOMMENDATIONS & IMPROVEMENTS")
    print("=" * 90)
    
    for bot_name, m in results['by_bot'].items():
        if bot_name == 'UNKNOWN':
            continue
        
        print(f"\n{'📌 ' + bot_name + ' BOT RECOMMENDATIONS'}")
        print("-" * 90)
        
        recommendations = []
        
        # Win rate analysis
        if m['win_rate_exc_be'] < 45:
            recommendations.append("❌ Low win rate - Review signal quality and entry criteria")
        elif m['win_rate_exc_be'] > 55:
            recommendations.append("✅ Good win rate - Focus on improving R:R ratio")
        
        # R:R analysis
        if m['avg_loss'] != 0:
            rr = abs(m['avg_win'] / m['avg_loss'])
            if rr < 1.0:
                recommendations.append(f"❌ Poor R:R ({rr:.2f}) - Tighten stop-losses or widen targets")
            elif rr > 1.5:
                recommendations.append(f"✅ Good R:R ({rr:.2f}) - Excellent risk management")
        
        # Profitability
        if m['total_pnl'] > 0:
            recommendations.append("✅ Profitable - Consider increasing position size gradually")
        else:
            recommendations.append("❌ Unprofitable - Pause and backtest with stricter filters")
        
        # BE trades
        be_rate = (m['be_trades'] / m['total_trades'] * 100) if m['total_trades'] > 0 else 0
        if be_rate > 15:
            recommendations.append(f"⚠️  High BE rate ({be_rate:.1f}%) - May indicate premature exits")
        
        # Long vs Short bias
        if m['long_metrics'] and m['short_metrics']:
            long_pnl = m['long_metrics']['total_pnl']
            short_pnl = m['short_metrics']['total_pnl']
            
            if abs(long_pnl - short_pnl) > 3:
                better = "LONG" if long_pnl > short_pnl else "SHORT"
                diff = abs(long_pnl - short_pnl)
                recommendations.append(f"📊 {better} trades perform {diff:.2f} USDT better - Consider bias")
        
        # Hold time
        if m['avg_hold_time'] < 2:
            recommendations.append("⚡ Very short hold time - Scalping strategy, watch fees impact")
        elif m['avg_hold_time'] > 48:
            recommendations.append("🕐 Long hold time - Swing strategy, ensure proper position sizing")
        
        for rec in recommendations:
            print(f"  • {rec}")
    
    # Overall system recommendations
    print(f"\n{'🎯 OVERALL SYSTEM IMPROVEMENTS'}")
    print("-" * 90)
    
    profitable_bots = [name for name, m in results['by_bot'].items() 
                       if name != 'UNKNOWN' and m['total_pnl'] > 0]
    
    if len(profitable_bots) == 0:
        print("  ⚠️  NO PROFITABLE BOTS - Critical system review needed!")
        print("  • Consider pausing all live trading")
        print("  • Backtest strategies with at least 6 months of data")
        print("  • Review signal generation logic")
    elif len(profitable_bots) == 1:
        print(f"  ⚠️  Only {profitable_bots[0]} is profitable - Diversification risk")
        print(f"  • Focus on improving {profitable_bots[0]}")
        print("  • Redesign unprofitable bots or pause them")
    
    print("\n  🔧 Technical Improvements:")
    print("  • Implement per-bot daily/weekly loss limits")
    print("  • Add correlation check to avoid duplicate signals")
    print("  • Track and optimize fee efficiency")
    print("  • Monitor slippage on market orders")
    print("  • Add time-of-day filters (some sessions may perform better)")
    
    print("\n  📊 Data Collection:")
    print("  • Log entry reason/signal strength for each trade")
    print("  • Track market conditions (volatility, trend)")
    print("  • Record exit reason (TP/SL/manual/BE)")
    
    print("=" * 90)

def save_detailed_csv(results, output_file):
    """Save classified trades to a CSV file with enhanced data."""
    df = results['classified_df']
    df_export = df[['Futures', 'Direction', 'Opening time', 'Closed time', 
                    'Bot', 'Closed_Value_Numeric', 'Net_PnL', 'PnL_Category',
                    'Hold_Time_Hours']].copy()
    df_export.to_csv(output_file, index=False)
    print(f"\n✅ Detailed results saved to: {output_file}")

if __name__ == "__main__":
    # File path
    csv_file = Path("/Users/raphaelblanchon/Downloads/CFTT/Export futures position history-2025-12-28 20_36_25 2.csv")
    
    # Analyze
    print("📊 Analyzing trading performance with enhanced metrics...\n")
    results = analyze_trading_performance(csv_file)
    
    # Print enhanced report
    print_enhanced_report(results)
    
    # Generate recommendations
    generate_recommendations(results)
    
    # Save detailed CSV
    output_file = Path("/Users/raphaelblanchon/Downloads/CFTT/trading_analysis_enhanced.csv")
    save_detailed_csv(results, output_file)
    
    print("\n✨ Enhanced analysis complete!")

