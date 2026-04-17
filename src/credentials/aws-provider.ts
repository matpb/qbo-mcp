// AWS-based credential provider using Secrets Manager and SSM Parameter Store

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type { CredentialProvider, QBCredentials } from "./types.js";

// Configuration from environment variables with sensible defaults
const REGION = process.env.AWS_REGION || "us-east-2";
const SECRET_NAME = process.env.QBO_SECRET_NAME || "prod/qbo";
const COMPANY_ID_PARAM = process.env.QBO_COMPANY_ID_PARAM || "/prod/qbo/company_id";

/**
 * AWS-based credential provider
 * Stores credentials in Secrets Manager and company ID in SSM Parameter Store
 */
export class AWSCredentialProvider implements CredentialProvider {
  private secretsClient: SecretsManagerClient;
  private ssmClient: SSMClient;
  private cachedCompanyId: string | null = null;

  constructor() {
    this.secretsClient = new SecretsManagerClient({ region: REGION });
    this.ssmClient = new SSMClient({ region: REGION });
  }

  async getCredentials(): Promise<QBCredentials> {
    const command = new GetSecretValueCommand({ SecretId: SECRET_NAME });
    const response = await this.secretsClient.send(command);

    if (!response.SecretString) {
      throw new Error("Secret value is empty");
    }

    return JSON.parse(response.SecretString) as QBCredentials;
  }

  async saveCredentials(credentials: QBCredentials): Promise<void> {
    const command = new PutSecretValueCommand({
      SecretId: SECRET_NAME,
      SecretString: JSON.stringify(credentials),
    });
    await this.secretsClient.send(command);
  }

  async getCompanyId(): Promise<string> {
    if (this.cachedCompanyId) {
      return this.cachedCompanyId;
    }

    const command = new GetParameterCommand({
      Name: COMPANY_ID_PARAM,
      WithDecryption: true,
    });
    const response = await this.ssmClient.send(command);

    if (!response.Parameter?.Value) {
      throw new Error("Company ID parameter not found");
    }

    this.cachedCompanyId = response.Parameter.Value;
    return this.cachedCompanyId;
  }

  async isConfigured(): Promise<boolean> {
    try {
      await this.getCredentials();
      await this.getCompanyId();
      return true;
    } catch {
      return false;
    }
  }
}

// Legacy exports for backward compatibility with src/aws.ts re-exports
export async function getSecret(): Promise<QBCredentials> {
  const provider = new AWSCredentialProvider();
  return provider.getCredentials();
}

export async function putSecret(credentials: QBCredentials): Promise<void> {
  const provider = new AWSCredentialProvider();
  return provider.saveCredentials(credentials);
}

export async function getCompanyId(): Promise<string> {
  const provider = new AWSCredentialProvider();
  return provider.getCompanyId();
}
