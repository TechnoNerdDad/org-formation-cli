import archiver = require('archiver');
import { existsSync, readFileSync } from 'fs';
import { S3 } from 'aws-sdk';
import { CreateStackInput, UpdateStackInput } from 'aws-sdk/clients/cloudformation';
import { PutObjectRequest } from 'aws-sdk/clients/s3';
import { Command } from 'commander';
import { WritableStream } from 'memory-streams';
import { CredentialsOptions } from 'aws-sdk/lib/credentials';
import { AwsUtil, CfnUtil, DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS } from '../util/aws-util';
import { ConsoleUtil } from '../util/console-util';
import { OrgFormationError } from '../org-formation-error';
import { BaseCliCommand, ICommandArgs } from './base-command';
import { Validator } from '~parser/validator';
import { S3StorageProvider } from '~state/storage-provider';


const commandName = 'init-pipeline';
const commandDescription = 'initializes organization and created codecommit repo, codebuild and codepipeline';

export class InitPipelineCommand extends BaseCliCommand<IInitPipelineCommandArgs> {
    private currentAccountId: string;
    private pipelineAccountId: string;
    private s3credentials: CredentialsOptions;

    constructor(command: Command) {
        super(command, commandName, commandDescription);
    }

    public addOptions(command: Command): void {
        command.option('--region <region>', 'region used to created state-bucket and pipeline in');
        command.option('--stack-name <stack-name>', 'stack name used to create pipeline artifacts', 'organization-formation-build');
        command.option('--resource-prefix <resource-prefix>', 'name prefix used when creating AWS resources', 'orgformation');
        command.option('--repository-name <repository-name>', 'name of the code commit repository created', 'organization-formation');
        command.option('--cross-account-role-name <cross-account-role-name>', 'name of the role used to perform cross account access', 'OrganizationAccountAccessRole');
        command.option('--build-account-id [build-account-id]', 'account id of the aws account that will host the orgformation build process');
        command.option('--role-stack-name [role-stack-name]', 'stack name used to create cross account roles for org-formation access. only used when --build-account-id is passed', 'organization-formation-build-role');

        super.addOptions(command);
    }

    public async performCommand(command: IInitPipelineCommandArgs): Promise<void> {
        if (!command.region) {
            throw new OrgFormationError('argument --region is missing');
        }

        // in this context currentAccountId is the master account
        this.currentAccountId = await AwsUtil.GetMasterAccountId();
        this.pipelineAccountId = this.currentAccountId;

        command.delegateToBuildAccount = command.buildAccountId !== undefined;
        if (command.delegateToBuildAccount) {
            command.buildProcessRoleName = 'OrganizationFormationBuildAccessRole';
            this.pipelineAccountId = command.buildAccountId;
        }
        AwsUtil.SetBuildAccountId(this.pipelineAccountId);

        Validator.validateRegion(command.region);

        if (command.crossAccountRoleName) {
            DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS.RoleName = command.crossAccountRoleName;
        }

        const region = command.region;

        const resourcePrefix = command.resourcePrefix;
        const stackName = command.stackName;
        const repositoryName = command.repositoryName;
        const stateBucketName = await BaseCliCommand.GetStateBucketName(command.stateBucketName);

        const codePipelineTemplateFileName = 'orgformation-codepipeline.yml';
        let path = __dirname + '/../../../resources/';
        if (!existsSync(path + codePipelineTemplateFileName)) {
            path = __dirname + '/../../resources/';
        }

        const replacements: Record<string, string> = {};
        replacements['XXX-resourcePrefix'] = resourcePrefix;
        replacements['XXX-stateBucketName'] = stateBucketName;
        replacements['XXX-stackName'] = stackName;
        replacements['XXX-repositoryName'] = repositoryName;
        replacements['XXX-region'] = region;

        replacements['XXX-organizationAccountAccessRoleName'] = command.crossAccountRoleName;
        replacements['XXX-roleStackName'] = command.roleStackName;

        const template = await this.generateDefaultTemplate(command.buildProcessRoleName);

        if (command.delegateToBuildAccount) {
            const buildAccountLogicalId = template.state.getLogicalIdForPhysicalId(command.buildAccountId);

            if (buildAccountLogicalId === undefined) {
                throw new OrgFormationError(`account with id ${command.buildAccountId} does not exist in organization`);
            }
            replacements['XXX-organizationFormationBuildAccessRoleName'] = command.buildProcessRoleName;
            replacements['XXX-buildAccountLogicalName'] = buildAccountLogicalId;
        }

        const buildSpecContents = this.createBuildSpecContents(path, command, stateBucketName);
        const cloudformationTemplateContents = readFileSync(path + codePipelineTemplateFileName).toString('utf8');
        const organizationTasksContents = command.delegateToBuildAccount
            ? this.createDelegatedBuildTaskFile(path, replacements)
            : this.createLocalBuildTaskFile(path, replacements);

        const buildAccessRoleTemplate = command.delegateToBuildAccount
            ? this.createBuildAccessRoleTemplate(path, command.buildProcessRoleName)
            : undefined;

        const stateStorageProvider = S3StorageProvider.Create(stateBucketName, command.stateObject);
        if (command.delegateToBuildAccount) {
            this.s3credentials = await AwsUtil.GetCredentials(command.buildAccountId, DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS.RoleName);
        }
        await stateStorageProvider.create(command.region, true, this.s3credentials);

        if (command.delegateToBuildAccount) {
            await this.executeOrgFormationRoleStack(this.currentAccountId, buildAccessRoleTemplate, region, command.roleStackName);
        }

        ConsoleUtil.LogInfo(`uploading initial commit to S3 ${stateBucketName}/initial-commit.zip...`);
        await this.uploadInitialCommit(stateBucketName, path + 'initial-commit/', template.template, buildSpecContents, organizationTasksContents, cloudformationTemplateContents, buildAccessRoleTemplate);

        ConsoleUtil.LogInfo('creating codecommit / codebuild and codepipeline resources using CloudFormation...');
        await this.executePipelineStack(this.pipelineAccountId, cloudformationTemplateContents, command.region, stateBucketName, resourcePrefix, stackName, repositoryName);

        await template.state.save(stateStorageProvider);

        await AwsUtil.DeleteObject(stateBucketName, 'initial-commit.zip', this.s3credentials);
        ConsoleUtil.LogInfo('done');

    }

    public uploadInitialCommit(stateBucketName: string, initialCommitPath: string, templateContents: string, buildSpecContents: string, organizationTasksContents: string, cloudformationTemplateContents: string, buildAccessRoleTemplateContents: string): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const s3client = new S3();
                const output = new WritableStream();
                const archive = archiver('zip');

                archive.on('error', reject);

                archive.on('end', () => {
                    const uploadRequest: PutObjectRequest = {
                        Body: output.toBuffer(),
                        Key: 'initial-commit.zip',
                        Bucket: stateBucketName,
                    };

                    s3client.upload(uploadRequest)
                        .promise()
                        .then(() => resolve())
                        .catch(reject);
                });

                archive.pipe(output);
                archive.directory(initialCommitPath, false);
                archive.append(buildSpecContents, { name: 'buildspec.yml' });
                archive.append(templateContents, { name: 'organization.yml' });
                archive.append(organizationTasksContents, { name: 'organization-tasks.yml' });
                archive.append(cloudformationTemplateContents, { name: 'templates/org-formation-build.yml' });
                if (buildAccessRoleTemplateContents !== undefined) {
                    archive.append(buildAccessRoleTemplateContents, { name: 'templates/org-formation-build-role.yml' });
                }

                archive.finalize();
            } catch (err) {
                reject(err);
            }
        });
    }

    public async executeOrgFormationRoleStack(targetAccountId: string, cfnTemplate: string, region: string, stackName: string): Promise<void> {
        const cfn = await AwsUtil.GetCloudFormation(targetAccountId, region, DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS.RoleName);
        const stackInput: CreateStackInput | UpdateStackInput = {
            StackName: stackName,
            TemplateBody: cfnTemplate,
            Capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_IAM'],
        };

        await CfnUtil.UpdateOrCreateStack(cfn, stackInput);
    }

    public async executePipelineStack(targetAccountId: string, cfnTemplate: string, region: string, stateBucketName: string, resourcePrefix: string, stackName: string, repositoryName: string): Promise<void> {
        const cfn = await AwsUtil.GetCloudFormation(targetAccountId, region, DEFAULT_ROLE_FOR_CROSS_ACCOUNT_ACCESS.RoleName);
        const stackInput: CreateStackInput | UpdateStackInput = {
            StackName: stackName,
            TemplateBody: cfnTemplate,
            Capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_IAM'],
            Parameters: [
                { ParameterKey: 'stateBucketName', ParameterValue: stateBucketName },
                { ParameterKey: 'resourcePrefix', ParameterValue: resourcePrefix },
                { ParameterKey: 'repositoryName', ParameterValue: repositoryName },
            ],
        };

        await CfnUtil.UpdateOrCreateStack(cfn, stackInput);
    }

    private createLocalBuildTaskFile(path: string, replacements: Record<string, string>): string {
        let buildSpecContents = readFileSync(path + 'local-build-orgformation-tasks.yml').toString('utf-8');

        for (const [key, val] of Object.entries(replacements)) {
            buildSpecContents = buildSpecContents.replace(key, val);
        }

        return buildSpecContents;
    }

    private createDelegatedBuildTaskFile(path: string, replacements: Record<string, string>): string {
        let buildSpecContents = readFileSync(path + 'delegated-build-orgformation-tasks.yml').toString('utf-8');

        for (const [key, val] of Object.entries(replacements)) {
            buildSpecContents = buildSpecContents.replace(key, val);
        }

        return buildSpecContents;
    }
    private createBuildAccessRoleTemplate(path: string, buildProcessRoleName: string): string {
        let buildSpecContents = readFileSync(path + 'orgformation-build-access-role.yml').toString('utf-8');

        buildSpecContents = buildSpecContents.replace('XXX-OrganizationFormationBuildAccessRole', buildProcessRoleName);

        return buildSpecContents;
    }
    private createBuildSpecContents(path: string, command: IInitPipelineCommandArgs, stateBucketName: string): string {
        let buildSpecContents = readFileSync(path + 'buildspec.yml').toString('utf-8');

        buildSpecContents = buildSpecContents.replace('XXX-ARGS', '--state-bucket-name ' + stateBucketName + ' XXX-ARGS');

        if (command.stateObject) {
            buildSpecContents = buildSpecContents.replace('XXX-ARGS', '--state-object ' + command.stateObject + ' XXX-ARGS');
        }

        if (command.delegateToBuildAccount) {
            buildSpecContents = buildSpecContents.replace('XXX-ARGS', '--master-account-id ' + this.currentAccountId + ' XXX-ARGS');
        }

        buildSpecContents = buildSpecContents.replace('XXX-ARGS', '');
        return buildSpecContents;
    }
}

export interface IInitPipelineCommandArgs extends ICommandArgs {
    region: string;
    stackName: string;
    resourcePrefix: string;
    repositoryName: string;
    crossAccountRoleName: string;
    buildAccountId?: string;
    roleStackName: string;
    buildProcessRoleName: string;
    delegateToBuildAccount: boolean;

}
