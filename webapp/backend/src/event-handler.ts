import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { FirehoseClient, PutRecordCommand } from '@aws-sdk/client-firehose';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { MetricsData, MetricsDataDao } from './ddb/metrics-dao';
import { SensorDao } from './ddb/sensor-dao';

const client = new DynamoDBClient({});
const ddb = DynamoDBDocument.from(client);
var firehose = new FirehoseClient({});

/**
 * {
 *     "sensorId": "777",
 *     "ecg": 24,
 *     "heartrate": 68,
 *     "temp": 36.7,
 *     "timestamp": 1643008976,
 * }
 */
export const handler = async (event: any = {}, context: any, callback: any): Promise<any> => {
    console.log('Event: ', event);

    // Query sensor information
    //
    const sensorDao = new SensorDao(ddb);
    const sensor = await sensorDao.getSensor(event.sensorId);

    if (!sensor) {
        console.error('Sensor not found');
        return;
    }

    console.log('sensorInfo: ', sensor);
    const patientId = sensor.patient_id;

    // TTL in 1 day, assumes input timestamp is in epoch seconds
    let timestamp = new Date(0);
    timestamp.setUTCSeconds(event.timestamp);
    let ttl = new Date(timestamp);
    ttl.setDate(timestamp.getUTCDate() + 1);

    const modalities = ["ecg", "heartrate", "temp"];
    const datapoints: MetricsData[] = [];
    modalities.forEach(modality => {
        if (modality in event) {
            const modifiedData = {
                patient_id: patientId,
                sensor_id: event.sensorId,
                timestamp: timestamp.toISOString(),
                ttl: (ttl.getTime() / 1000) | 0,
                measure_type: modality,
                measure_value: event[modality],
            };
            datapoints.push(modifiedData);

            // // Rename IoT-provided timestamp (event.ts)
            // modifiedData['iot_timestamp'] = modifiedData['ts'];
            // delete modifiedData['ts'];
            // console.log('Data for DDB:\n', modifiedData);        
        }
    });
    
    const metricsDataDao = new MetricsDataDao(ddb);
    await metricsDataDao.saveMetrics(datapoints);

    // Write to Firehose -> S3 data lake
    const firehoseData = { ...event, patientId };
    const command = new PutRecordCommand({
        DeliveryStreamName: process.env.DELIVERY_STREAM_NAME!,
        Record: {
            Data: Buffer.from(JSON.stringify(firehoseData)),
        },
    });
    const firehoseRes = await firehose.send(command);

    console.log('firehoseRes: ', firehoseRes);
};
