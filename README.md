# Application TAUX DE SORTIE (Shopify intégrée)

Cette app s'affiche directement dans l'admin Shopify (dans un onglet d'application) et permet :

- de prendre un **snapshot de stock de départ** par saison
- de suivre les **ventes** via un webhook `orders/create`
- de calculer le **taux de sortie (sell-through)** par variante

## 1. Installation locale

```bash
npm install
```

Créer un fichier `.env` à la racine :

```env
SHOP_NAME=vitamine-club.myshopify.com
ADMIN_API_TOKEN=TON_TOKEN_ADMIN_API_ICI
API_VERSION=2024-10
PORT=3000
```

Puis :

```bash
npm start
```

L'app écoute sur `http://localhost:3000`.

Pour la connecter à Shopify, utilise un tunnel (ngrok) et mets l'URL dans les paramètres de l'application comme **URL de l'application**.

## 2. Déploiement sur Railway

1. Zipper ce projet et l'importer dans Railway comme "New Project from ZIP".
2. Dans Railway → Variables d'env :
   - `SHOP_NAME=vitamine-club.myshopify.com`
   - `ADMIN_API_TOKEN=ton_token`
   - `API_VERSION=2024-10`
3. Copier l'URL publique Railway (ex: `https://taux-de-sortie.up.railway.app`)
4. Dans Shopify Admin → Applications → taux de sortie → Paramètres de l'application :
   - Mettre cette URL comme **URL de l'application**

## 3. Webhooks à configurer dans Shopify

Dans les paramètres de l'app :

- Webhook `orders/create` → `POST https://ton-url-app/webhooks/orders_create`
- Webhook `inventory_levels/update` → `POST https://ton-url-app/webhooks/inventory_levels_update`

(optionnel pour le deuxième si tu veux juste le taux de sortie basé sur les ventes)

Une fois en place :

- Clique sur l'app **taux de sortie** dans Shopify
- Depuis l'iframe, clique sur "Définir le stock de départ (snapshot)"
- Ensuite, les ventes vont alimenter le tableau automatiquement.
