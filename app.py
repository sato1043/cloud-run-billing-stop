import base64
import json
from googleapiclient import discovery
import os
from flask import Flask, request

app = Flask(__name__)
PROJECT_ID = os.environ.get('GCP_PROJECT')

@app.route('/', methods=['POST'])
def index():
    data = request.get_json()
    if not data or 'message' not in data or 'data' not in data['message']:
        print("Invalid Pub/Sub message format.")
        return 'Invalid request', 400

    pubsub_message = data['message']
    message_data = base64.b64decode(pubsub_message['data']).decode('utf-8')
    print(f"Received Pub/Sub message: {message_data}")
    print(f"Project ID: {PROJECT_ID}")

    try:
        compute_service = discovery.build('compute', 'v1')
        zones_response = compute_service.zones().list(project=PROJECT_ID).execute()
        for zone_data in zones_response['items']:
            zone = zone_data['name']
            instances_response = compute_service.instances().list(project=PROJECT_ID, zone=zone).execute()
            if 'items' in instances_response:
                for instance in instances_response['items']:
                    if instance['status'] == 'RUNNING':
                        print(f"Stopping instance: {instance['name']} in zone: {zone}")
                        stop_request = compute_service.instances().stop(
                            project=PROJECT_ID,
                            zone=zone,
                            instance=instance['name']
                        )
                        stop_request.execute()
                        print(f"Instance {instance['name']} stopped successfully.")
    except Exception as e:
        print(f"Error stopping Compute Engine instances: {e}")

    return 'OK', 200

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
