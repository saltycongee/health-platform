import cdk = require('@aws-cdk/core');
import { CfnTable, Database } from '@aws-cdk/aws-glue';
import { Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal, ManagedPolicy, FederatedPrincipal } from '@aws-cdk/aws-iam';
import { IotSql, TopicRule } from '@aws-cdk/aws-iot';
import { LambdaFunctionAction } from '@aws-cdk/aws-iot-actions';
import { CfnDeliveryStream } from '@aws-cdk/aws-kinesisfirehose';
import * as lambda from "@aws-cdk/aws-lambda";
import { LogGroup, RetentionDays } from '@aws-cdk/aws-logs';
import { Bucket, BucketEncryption } from '@aws-cdk/aws-s3';
import { HealthPlatformDynamoStack } from './dynamodb-stack';
import { CfnIdentityPool, CfnIdentityPoolRoleAttachment } from '@aws-cdk/aws-cognito';
import * as timestream from '@aws-cdk/aws-timestream';
import * as iot from '@aws-cdk/aws-iot';

// This stack contains resources used by the IoT data flow.

export class HealthPlatformIotStack extends cdk.Stack {

    private static GLUE_TABLE_NAME = "health-platform-glue-table"
    private static PARQUET_METRICS_PREFIX = "health-platform-metrics-"
    private static LAYER_CODE_PREFIX = "health-platform-layer-code-"

    public readonly lambdaRole: Role;

    constructor(app: cdk.App, id: string) {
        super(app, id, {
            env: {
                region: 'us-west-2'
            },
        });
        
        this.lambdaRole = new Role(this, 'HealthPlatformBackendIotLambdaRole', {
            roleName: 'HealthPlatformBackendIotLambdaRole',
            assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
            inlinePolicies: {
                additional: new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                // TimeStream
                                "timestream:WriteRecords",
                                "timestream:DescribeEndpoints",
                                "timestream:DescribeTable",
                                "timestream:ListDatabases",
                                "timestream:ListMeasures",
                                // DynamoDB
                                "dynamodb:GetItem",
                                "dynamodb:DeleteItem",
                                "dynamodb:PutItem",
                                "dynamodb:Scan",
                                "dynamodb:Query",
                                "dynamodb:UpdateItem",
                                "dynamodb:BatchWriteItem",
                                "dynamodb:BatchGetItem",
                                "dynamodb:DescribeTable",
                                "dynamodb:ConditionCheckItem",
                                // IAM
                                'iam:GetRole',
                                'iam:PassRole',
                                // Firehose
                                "firehose:PutRecord",
                                "firehose:PutRecordBatch",
                                // Lambda
                                'lambda:InvokeFunction',
                                // STS
                                'sts:AssumeRole',
                                // CloudWatch
                                'cloudwatch:*',
                                'logs:*',
                            ],
                            resources: ['*']
                        })
                    ]
                }),
            },
        });

        const cfnPolicy = new iot.CfnPolicy(this, 'HealthPlatformIotPolicy', {
            policyDocument: {
                "Version": "2012-10-17",
                "Statement": [
                  {
                    "Effect": "Allow",
                    "Action": "iot:Connect",
                    "Resource": "*"
                  },
                  {
                    "Effect": "Allow",
                    "Action": [
                      "iot:Publish",
                      "iot:Subscribe",
                      "iot:Receive"
                    ],
                    "Resource": "*"
                  }
                ]
              },
            policyName: 'HealthPlatformIotPolicy',
          });

        const cognitoIdentityPool = new CfnIdentityPool(this, 'HealthPlatformIdentityPool', {
            identityPoolName: 'HealthPlatformIdentityPool',
            allowUnauthenticatedIdentities: true,
        });

        const cognitoUnauthourizedRole = new Role(this, 'CognitoUnauthourizedRole', {
            roleName: "CognitoUnauthourizedRole",
            assumedBy: new FederatedPrincipal(
                "cognito-identity.amazonaws.com",
                {
                    StringEquals: {
                        "cognito-identity.amazonaws.com:aud": cognitoIdentityPool.ref
                    },
                    "ForAnyValue:StringLike": {
                        "cognito-identity.amazonaws.com:amr": "unauthenticated"
                    }
                },
                "sts:AssumeRoleWithWebIdentity"
            ),
            description: 'Role for sensor devices',
            maxSessionDuration: cdk.Duration.seconds(3600),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName("AWSIoTFullAccess")
            ]
        }); 
        
        cognitoUnauthourizedRole.addToPolicy(new PolicyStatement( {
            effect: Effect.ALLOW,
            resources: ["*"],
            actions: [
                "mobileanalytics:PutEvents",
                "cognito-sync:*"
            ]
        }));

        const identityPoolRoleAttachment = new CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleMapping', {
            identityPoolId: cognitoIdentityPool.ref,
            roles: {
                unauthenticated: cognitoUnauthourizedRole.roleArn
            }
        });

        const healthDatabase = new timestream.CfnDatabase(this, 'HealthDatabase',  {
            databaseName: 'HealthDatabase',
        });
        
        const dataTable = new timestream.CfnTable(this, 'MetricsDataTable', {
            databaseName: healthDatabase.ref,
            retentionProperties: {
                MemoryStoreRetentionPeriodInHours : "24",
                MagneticStoreRetentionPeriodInDays : "7"
            },
            tableName: 'MetricsDataTable',
        });

        let kinesisLogGroup = new LogGroup(this, "HealthPlatformKinesisLogGroup", {
            retention: RetentionDays.ONE_MONTH,
        });

        let parquetMetricsBucket = new Bucket(this, 'HealthPlatformParquetMetricsBucket', {
            bucketName: HealthPlatformIotStack.PARQUET_METRICS_PREFIX + this.account,
            encryption: BucketEncryption.S3_MANAGED,
        });

        let parquetDeliveryStreamRole = new Role(this, 'HealthPlatformDeliveryStreamRole', {
            roleName: 'HealthPlatformDeliveryStreamRole',
            assumedBy: new ServicePrincipal('firehose.amazonaws.com'),
            path: "/",
            inlinePolicies: {
                additional: new PolicyDocument({
                    statements: [
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                's3:AbortMultipartUpload',
                                's3:GetBucketLocation',
                                's3:GetObject',
                                's3:PutObject',
                                's3:ListBucket',
                                's3:ListBucketMultipartUploads',
                            ],
                            resources: [
                                parquetMetricsBucket.bucketArn,
                                `${parquetMetricsBucket.bucketArn}/`,
                                `${parquetMetricsBucket.bucketArn}/*`,
                            ]
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'glue:GetTableVersions',
                            ],
                            resources: ['*']
                        }),
                        new PolicyStatement({
                            effect: Effect.ALLOW,
                            actions: [
                                'logs:CreateLogGroup',
                                'logs:CreateLogStream',
                                'logs:PutDestination',
                                'logs:PutLogEvents',
                            ],
                            resources: ['*']
                        })
                    ]
                }),
            },
        });

        let glueDatabase = new Database(this, 'HealthPlatformGlueDatabase', {
            databaseName: 'health-platform-glue-db',
        });

        let glueTable = new CfnTable(this, 'HealthPlatformGlueTable', {
            databaseName: glueDatabase.databaseName,
            catalogId: this.account,
            tableInput: {
                name: HealthPlatformIotStack.GLUE_TABLE_NAME,
                owner: "owner",
                retention: 0,
                storageDescriptor: {
                    columns: [
                        {'name': 'patientId', 'type': 'string'},
                        {'name': 'sensorId', 'type': 'string'},
                        {'name': 'timestamp', 'type': 'int'},
                        {'name': 'temp', 'type': 'int'},
                        {'name': 'heartrate', 'type': 'int'},
                        {'name': 'ecg', 'type': 'int'},
                    ],
                    inputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat",
                    outputFormat: "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat",
                    compressed: false,
                    numberOfBuckets: -1,
                    serdeInfo: {
                        serializationLibrary: "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe",
                        parameters: {
                            "serialization.format": "1",
                        }
                    },
                    bucketColumns: [],
                    sortColumns: [],
                    storedAsSubDirectories: false,
                },
                partitionKeys: [
                    {'name': 'year', 'type': 'string'},
                    {'name': 'month', 'type': 'string'},
                    {'name': 'day', 'type': 'string'},
                ],
                tableType: "EXTERNAL_TABLE",
            },
        });

        let parquetDeliveryStream = new CfnDeliveryStream(this, 'HealthPlatformDeliveryStream', {
            deliveryStreamName: "HealthPlatformDeliveryStream",
            extendedS3DestinationConfiguration: {
                bucketArn: parquetMetricsBucket.bucketArn,
                bufferingHints: {
                    intervalInSeconds: 60,
                    sizeInMBs: 64
                },
                cloudWatchLoggingOptions: {
                    enabled: true,
                    logStreamName: 'ParquetS3Delivery',
                    logGroupName: kinesisLogGroup.logGroupName
                },
                compressionFormat: 'UNCOMPRESSED',
                encryptionConfiguration: {
                    noEncryptionConfig: 'NoEncryption',
                },
                prefix: 'data/year=!{timestamp:YYYY}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/',
                errorOutputPrefix: 'error/!{firehose:error-output-type}/year=!{timestamp:YYYY}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/',
                roleArn: parquetDeliveryStreamRole.roleArn,
                dataFormatConversionConfiguration: {
                    enabled: true,
                    inputFormatConfiguration: {
                        deserializer: {
                            openXJsonSerDe: {}
                        }
                    },
                    outputFormatConfiguration: {
                        serializer: {
                            parquetSerDe: {}
                        }
                    },
                    schemaConfiguration: {
                        catalogId: this.account,
                        databaseName: glueDatabase.databaseName,
                        region: this.region,
                        tableName: HealthPlatformIotStack.GLUE_TABLE_NAME,
                        roleArn: parquetDeliveryStreamRole.roleArn,
                        versionId: "LATEST",
                    }
                },
            }
        });

        const layer = new lambda.LayerVersion(this, 'health-platform-layer', {
            code: lambda.Code.fromAsset(`layer/nodejs.zip`),
            compatibleRuntimes: [lambda.Runtime.NODEJS_14_X],
         });

        const eventHandlerFunction = new lambda.Function(this, 'EventHandlerFunction', {
            functionName: "Event-Handler-Function",
            code: new lambda.AssetCode('build/src'),
            handler: 'event-handler.handler',
            runtime: lambda.Runtime.NODEJS_14_X,
            role: this.lambdaRole,
            environment: {
                // "DATA_TABLE_NAME": HealthPlatformDynamoStack.DATA_TABLE,
                "SENSOR_MAPPING_TABLE_NAME": HealthPlatformDynamoStack.SENSOR_TABLE,
                "DELIVERY_STREAM_NAME": parquetDeliveryStream.deliveryStreamName!,
            },
            memorySize: 512,
            timeout: cdk.Duration.seconds(300),
            layers: [layer] 
        });

        new lambda.Function(this, 'GenerateDataFunction', {
            functionName: "Generate-Data-Function",
            code: new lambda.AssetCode('build/src'),
            handler: 'generate-data.handler',
            runtime: lambda.Runtime.NODEJS_14_X,
            role: this.lambdaRole,
            environment: {
                // "DATA_TABLE_NAME": HealthPlatformDynamoStack.DATA_TABLE,
                "SENSOR_MAPPING_TABLE_NAME": HealthPlatformDynamoStack.SENSOR_TABLE,
                "DELIVERY_STREAM_NAME": parquetDeliveryStream.deliveryStreamName!,
            },
            memorySize: 512,
            timeout: cdk.Duration.seconds(300), 
        });
        
        let iotTopicRule = new TopicRule(this, 'IoTTopicRule', {
            topicRuleName: "TopicRulePayload",
            description: "Send IoT Device data in raw format to Kinesis Analytics",
            enabled: true,
            sql: IotSql.fromStringAsVer20160323('SELECT * FROM "iot_device_analytics"'),
            actions: [
                new LambdaFunctionAction(eventHandlerFunction),
            ],
        });

        new lambda.CfnPermission(this, 'IoTRuleLambdaPermission', {
            action: "lambda:InvokeFunction",
            principal: "iot.amazonaws.com",
            sourceArn: iotTopicRule.topicRuleArn,
            sourceAccount: this.account,
            functionName: eventHandlerFunction.functionArn,
        });
    }
}
