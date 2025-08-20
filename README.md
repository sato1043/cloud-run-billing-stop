
### GCP 予算超過時の自動停止手順（Cloud Run (node.js/TS版)）

この手順は、GCPプロジェクトの月額請求額が X 円に達した際、
Cloud Runサービス `cloud-run-billing-stop` をトリガーして自動的に
Compute Engineインスタンスを停止、さらに今回は付録としてプロジェクトの課金も無効化する、
個人開発者に優しい仕組みを構築するためのものです。

（信用に足りないやっつけ仕事の設定ですので、頼り過ぎに注意しつつご参考まで）


### 1. Cloud Run コンテナの準備

まず、Cloud RunサービスにデプロイするソースコードをGitHubに格納します

1.  GitHubで新しいプライベートリポジトリ`cloud-run-billing-stop`（とかなんとか）を作成し、`develop`ブランチ（とかなんとか）を設定します

2.  ローカル環境に`cloud-run-billing-stop`をクローンしてコードをコミットしておきます
   （まだpushしないでおきます）

    1. `src/cloud-run-billing-stop.ts`

    ```typescript
    import { google } from 'googleapis';
    import * as functions from 'firebase-functions/v2';
    import express from 'express';
    import bodyParser from 'body-parser';
    import { Request, Response } from 'express';

    const app = express();
    app.use(bodyParser.json());

    // PROJECT_ID の参照方法はプロジェクトに合わせて調整（環境変数/引数受け取りなど）
    const project = process.env.GCP_PROJECT;
    if (!project) {
      throw new Error('GCP_PROJECT is not set.');
    }

    // Pub/Subメッセージの型定義
    interface PubSubMessage {
      attributes: { [key: string]: string };
      data: string;
      messageId: string;
      publishTime: string;
    }

    // Cloud Billingアラートデータの型定義
    interface BillingAlertData {
      budgetDisplayName: string;
      costAmount: number;
      budgetAmount: number;
      alertThresholdExceeded: number;
      projectName: string;
    }

    // Compute Engineインスタンスを停止する関数
    const stopComputeInstances = async () => {
      try {
        const auth = await google.auth.getClient({
          scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        const compute = google.compute({ version: 'v1', auth });

        functions.logger.log(`Checking project: ${project} for running instances...  `);

        const zonesResponse = await compute.zones.list({ project });
        const zones = zonesResponse.data.items || [];

        for (const { name: zone } of zones) {
          if (!zone) {
            functions.logger.warn('Encountered a zone without name. Skipping.');
            continue;
          }

          const instancesResponse = await compute.instances.list({ project, zone });
          const instances = instancesResponse.data.items || [];

          for (const { name: instance, status } of instances) {
            if (status !== 'RUNNING') { continue; }
            if (!instance) {
              functions.logger.error(`Can't stop NO_NAME instance in zone:   ${zone}`);
              continue;
            }
            functions.logger.log(`Stopping instance: ${project} / ${zone} /   ${instance}`);
            await compute.instances.stop({ project, zone, instance });
            functions.logger.log(`Instance ${instance} stopped successfully.`);
          }
        }
      } catch (e) {
        functions.logger.error(`Error stopping Compute Engine instances: ${e}`);
      }
    };

    // プロジェクトの課金を無効化する関数
    const disableProjectBilling = async () => {
      const name = `projects/${project}`;

      try {
        functions.logger.log(`Authoring client...`);

        const auth = await google.auth.getClient({
          scopes: ['https://www.googleapis.com/auth/cloud-billing'],
        });

        functions.logger.log(`Checking billing status for project: ${project}...`);

        const billing = google.cloudbilling({ version: 'v1', auth });
        const projectBillingInfo = await billing.projects.getBillingInfo({ name });

        if (projectBillingInfo.data.billingEnabled) {
          functions.logger.log("Disabling billing for the project...");
          await billing.projects.updateBillingInfo({ name, requestBody: {   billingAccountName: '' } });
           functions.logger.log("Project billing disabled successfully.");
        } else {
          functions.logger.log("Project billing is already disabled.");
        }
      } catch (e) {
        functions.logger.error(`Error disabling project billing: ${e}`);
      }
    };

    // Pub/Subからのメッセージを受け取るHTTPエンドポイント
    app.post('/', async (req: Request, res: Response) => {
      try {
        const pubsubMessage = req.body.message as PubSubMessage;
        if (!pubsubMessage || !pubsubMessage.data) {
          functions.logger.error("Invalid Pub/Sub message format.");
          return res.status(400).send('Invalid request');
        }

        const messageData = Buffer.from(pubsubMessage.data, 'base64').toString();
        functions.logger.log(`Received Pub/Sub message: ${messageData}`);
        functions.logger.log(`Project ID: ${project}`);

        const alertData: BillingAlertData = JSON.parse(messageData);
        const costAmount = alertData.costAmount;
        const budgetAmount = alertData.budgetAmount;

        // 費用が予算の99%を超えているかチェック
        if (costAmount / budgetAmount >= 0.99) {
          functions.logger.log(`Cost amount ${costAmount} has exceeded 99% of budget ${budgetAmount}. Executing stop and disable actions.`);

          // 予算超過時にCompute Engineインスタンスを停止
          await stopComputeInstances();

          // プロジェクトの課金を無効化
          await disableProjectBilling();
        } else {
          functions.logger.log(`Cost amount ${costAmount} has not yet exceeded 99% of budget ${budgetAmount}. No action taken.`);
        }

        res.status(200).send('OK');
      } catch (e) {
        functions.logger.error(`Error processing Pub/Sub message: ${e}`);
        res.status(500).send('Internal Server Error');
      }
    });

    const port = process.env.PORT || 8080;
    app.listen(port, () => {
      functions.logger.log(`Server is running on port ${port}`);
    });
    ```

    2. `cloud-run-billing-stop/package.json`

    ```json
    {
      "name": "cloud-run-billing-stop",
      "version": "1.0.0",
      "description": "Stops GCP resources on billing alert.",
      "main": "src/cloud-run-billing-stop.ts",
      "scripts": {
        "start": "tsx src/cloud-run-billing-stop"
      },
      "dependencies": {
        "@types/express": "5.0.3",
        "@types/node": "20.19.11",
        "express": "4.19.2",
        "firebase-functions": "6.4.0",
        "googleapis": "140.0.1",
        "tsx": "4.20.4"
      }
    }
    ```

    3. `cloud-run-billing-stop/tsconfig.json`

    ```json
    {
      "compilerOptions": {
        "target": "es2020",
        "module": "commonjs",
        "outDir": "./dist",
        "rootDir": "./src",
        "strict": true,
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true
      }
    }
    ```

    4. `cloud-run-billing-stop/Dockerfile`

    ```dockerfile
    FROM node:20-slim
    WORKDIR /usr/src/app
    COPY package*.json ./
    RUN npm install
    COPY . .
    RUN npm run build
    EXPOSE 8080
    CMD [ "npm", "start" ]
    ```


-----

### 2. APIとサービスを有効にする

予算超過の通知を自動化する GCP 設定のための最初のステップです

1.  Google Cloud Consoleで「**APIとサービス**」に移動します
2.  以下の API を有効化
   - Compute Engine API
   - Cloud Billing API

### 3. Cloud Billingで予算とPub/Sub通知を設定する

1.  Google Cloud Consoleで「**お支払い**」に移動します
2.  「**予算とアラート**」を選択し、「**予算を作成**」をクリック
3.  **予算の定義**:
    * **名前**: `10K` とかなんとかと入力
    * **予算の範囲**: > **プロジェクト** に 管理下におくプロジェクトIDを選択
    * 次へ
4.  **予算額の設定**:
    * **予算の種類**: `指定した金額`を選択し、予算額に `10,000` とかなんとかと入力
    * **期間**: `月額`
    * 次へ
5.  **予算しきい値のルールとアクションの設定**:
    * **しきい値**: `予算の割合100%の実値`
    * 「**通知の管理**」セクションで「**この予算に Pub/Sub トピックを接続する**」にチェック
    * **トピック名**: `disable-billing-alert-pubsub`
    * 完了して予算を保存


### 4. Cloud Runサービスをデプロイする

予算超過の通知を受け取り、自動停止を実行するコードをデプロイします

1.  Cloud Run サービスを作成

    * **デプロイするリビジョン**
        * **ソースコード**: 「**ソースから新しいリビジョンを継続的にデプロイ**」を選択
        * **ソース リポジトリ**: ここで**GitHub**を選択し、認証を行います
        * GitHubアカウントを接続し、リポジトリ`cloud-run-billing-stop`を指定
        * **ブランチ**: `develop` を指定
        * **ビルド構成**: `Dockerfile` を選択
    * **サービスの基本設定**
        * **サービス名**: `cloud-run-billing-stop`
        * **リージョン**: **`asia-northeast1 (東京)`** など各自のリージョンを選択
        * **認証**: **「認証が必要」** を選択
    * **詳細設定**
        * **コンテナポート**: `8080`
        * **CPU割り当て**: `1`
        * **メモリ割り当て**: `512MiB`
        * **最小インスタンス数**: `0`
        * **最大インスタンス数**: `1`
        * **リクエストタイムアウト**: `300`秒
        * **同時実行数**: `1`
    * **作成** をクリックしてCloud Runサービスをデプロイ
    * コンソールからサービスのデプロイを確認できたら、Githubへコードを push （連動してCloud Run のコンテナのリビルドがトリガーします）
    * push したコードでコンテナ作成できることを確認

2.  Cloud Run サービスの Pub/Subトリガー設定

    * デプロイ後、Cloud Run サービス`cloud-run-billing-stop`の詳細ページで「**トリガー**」タブに移動
    * 「**トリガーを追加**」をクリック
    * **トリガーのタイプ**: `Cloud Pub/Sub`
    * **トピック**: `disable-billing-alert-pubsub` を選択
    * **サービスアカウント**: Pub/Subがこのサービスを呼び出すためのサービスアカウントを選択（今回は Default compute engine account で済ませた）
    * 保存


### 5. サービスアカウントに請求の設定変更ができる IAM 権限を付与する

Cloud RunサービスがGCPリソースを操作できるように、適切な権限を付与します

Cloud Runサービスが使用するサービスアカウント（今回は標準のGCEアカウント）に以下の役割を付与

* **プロジェクトレベル**:
    * **Compute インスタンス管理者 (v1)**
    * **プロジェクト請求管理者**
    * **ログ書き込み**
* **課金アカウントレベル**:
    * **課金アカウントユーザー**

さらに、Pub/SubからのリクエストがCloud Runで受けられるように、**Pub/Subトリガーで使用するサービスアカウント**に以下の権限を付与

* **Cloud Runサービスレベル**: `cloud-run-billing-stop`というサービスに対して、**Cloud Run 起動元**(`roles/run.invoker`)の役割を付与

-----


### 6. 動作確認

実際に予算を超過させることなく、設定した自動停止の仕組みが機能するかを検証します。

1.  **テスト用リソースの準備**:

    * プロジェクト `updaterllc-billing-master` に、テスト用のVMインスタンス（例: `test-vm-instance`）を立ち上げ、「実行中」であることを確認します。

2.  **Pub/Subトピックへのメッセージ手動送信**:

    * Google Cloud Consoleで「**Pub/Sub**」に移動します。

    * **トピック名**`disable-billing-alert-pubsub`を選択します。

    * 詳細ページ内の「**メッセージ**」タブから、「**メッセージをパブリッシュ**」をクリックします。

    * 以下のJSONデータをメッセージ本文に入力します。

      ```json
      {
        "budgetDisplayName": "10K",
        "budgetAmount": 10000.0,
        "costAmount": 10001.0
      }
      ```

    * **公開**

3.  **Cloud Runサービスのログ確認**:

    * Cloud Runでサービス `cloud-run-billing-stop` の「**ログ**」タブを確認します。
    * ログに`Cost amount 10001 has exceeded 99% of budget 10000. Executing stop and disable actions.`のようなメッセージが表示されていることを確認します。

4.  **リソースの状態確認**:

    * Cloud Consoleで「**Compute Engine**」の「**VMインスタンス**」ページに移動
    * `test-vm-instance`のステータスが「**停止済み**」になっていることを確認
    * コードで課金を無効にする場合は、プロジェクトの「お支払い」ページで確認


以上
