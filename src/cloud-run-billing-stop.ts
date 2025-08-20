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

    functions.logger.log(`Checking project: ${project} for running instances...`);

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
          functions.logger.error(`Can't stop NO_NAME instance in zone: ${zone}`);
          continue;
        }
        functions.logger.log(`Stopping instance: ${project} / ${zone} / ${instance}`);
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
      await billing.projects.updateBillingInfo({ name, requestBody: { billingAccountName: '' } });
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
      // await stopComputeInstances();

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
