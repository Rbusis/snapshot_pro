# Plan de Transition : TOP 30 -> JTF MAJORS (Phase 3)

Ce document prépare la transformation du bot `TOP 30` en un bot spécialisé sur les leaders du marché (**Majors**) pour améliorer la stabilité et la rentabilité du portefeuille.

## 🎯 Objectifs
1. **Éliminer le bruit** : Arrêter de trader les Memecoins (WIF, PEPE, DOGE) avec ce bot (déjà couverts par DEGEN/DISCOVERY).
2. **Cibler le Bitcoin** : Capturer les micro-pivots du BTC, ETH et SOL.
3. **Optimiser le Levier** : Utiliser la stabilité des Majors pour augmenter l'exposition sans risque excessif de liquidation.

---

## 🛠️ Modifications de Configuration (`autoselect.js`)

### 1. Liste de Symboles Restreinte
On réduit la liste aux 3 actifs les plus liquides et techniques :
```javascript
const SYMBOLS = [
  "BTCUSDT_UMCBL", 
  "ETHUSDT_UMCBL", 
  "SOLUSDT_UMCBL"
];
```

### 2. Augmentation de la Sensibilité (MMS Score)
Le BTC bouge moins que les Alts. Pour qu'il déclenche des signaux, on multiplie sa sensibilité par 3.
*   **Actuellement** : Diviseur `/ 3` (nécessite 1.8% de move).
*   **Cible Majors** : Pas de diviseur (nécessite **0.6%** de move).
```javascript
// Nouvelle formule suggérée
const MMS_long = toScore100(-(dP15 / 1) || 0);
const MMS_short = toScore100(+(dP15 / 1) || 0);
```

### 3. Ajustement du Levier
Pour un trade sur le BTC, un levier de 4x est très conservateur. On passera à :
```javascript
const SUGGESTED_LEVERAGE = "10x";
```

---

## 📈 Stratégie de Trading
*   **Mean Reversion** : Conserver la logique actuelle (vente sur extension haute, achat sur extension basse).
*   **Bias Dynamique** : Le bot continuera d'utiliser `market_bias.js` pour favoriser le sens du BTC.
*   **Anti-Flip** : Le cooldown de 15 minutes déjà en place sera crucial pour éviter les faux signaux sur le BTC lors de périodes de squeeze.

### 🛡️ Gestion Temporelle & Sécurité (Nouveau)

| Mesure | Justification | Action Proposée |
| :--- | :--- | :--- |
| **Filtre "Midnight"** | Perte de **-9.09 USDT** à 00h (TW) | Mettre le bot en pause entre 23h30 et 00h30. |
| **Verified Partial TP** | Sécurisation déjà active à 1R (50% TP) | Maintenir le TP @ 1R sur DEGEN/DISCOVERY. |
| **Zone de Force** | Profit max entre 14h et 17h (TW) | Surveiller pour augmenter l'agressivité. |

### 🚀 Améliorations Avancées (Nouveau)

| Module | Impact | Condition de Filtre |
| :--- | :--- | :--- |
| **Orderbook Imbalance** | Évite d'entrer face à un mur d'ordres | Bloquer LONG si le carnet est lourd à la vente (Ratio < 0.8). |
| **Funding Rate** | Évite l'euphorie / les Squeezes | Pas de LONG si le Funding est trop élevé (> 0.03%). |
| **OI Liquidation** | Capture les retournements après purge | Privilégier les signaux après une chute nette de l'Open Interest. |

---

## 🗓️ Calendrier d'Exécution
*   **Analyse finale Phase 2** : Lundi 12 Janvier matin.
*   **Déploiement JTF MAJORS** : Lundi 12 Janvier après-midi.
*   **Lancement Phase 3** : Immédiatement après.

---

## 🔍 Réflexions pour Phase 4 (À vérifier)

| Sujet | Observation | Amélioration Possible |
| :--- | :--- | :--- |
| **Scoring SWING** | L'Open Interest (OI) ne pèse que pour 8 pts | Augmenter le poids de l'OI (ex: 15 pts) pour mieux capter les flux institutionnels. |
| **Logique de Score** | Système purement additif actuel | Tester des **multiplicateurs** (ex: si Vola = Casino, Score x 0) pour bloquer les trades à risque. |
| **Corrélation Secteur** | Risque de doublons (ex: WIF + PEPE + DOGE) | Créer un "Filtre de Catégorie" pour limiter l'exposition simultanée sur un même secteur. |
| **Force de Tendance** | Risque de Mean-Reversion contre un mur | Ajouter un indicateur de force (ex: ADX ou pente EMA 200) pour éviter de shorter un "God Candle". |

---
*Fichier mis à jour le 09/01/2026 pour préparation Phase 3 & 4.*
