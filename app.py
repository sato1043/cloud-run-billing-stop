import base64
import json
import os
from flask import Flask, request
from googleapiclient import discovery

app = Flask(__name__)
PROJECT_ID = os.environ.get('GCP_PROJECT')

def stop_compute_instances():
    """Stops all running Compute Engine instances in the project."""
    try:
        compute_service = discovery.build('compute', 'v1')
        zones_response = compute_service.zones().list(project=PROJECT_ID).execute()
        for zone_data in zones_response.get('items', []):
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

def disable_project_billing():
    """Disables billing for the project."""
    try:
        billing_service = discovery.build('cloudbilling', 'v1')
        project_billing_info = billing_service.projects().getBillingInfo(
            name=f'projects/{PROJECT_ID}'
        ).execute()
        if project_billing_info.get('billingEnabled'):
            print("Disabling billing for the project...")
            billing_body = {'billingAccountName': ''}
            billing_service.projects().updateBillingInfo(
                name=f'projects/{PROJECT_ID}', body=billing_body
            ).execute()
            print("Project billing disabled successfully.")
    except Exception as e:
        print(f"Error disabling project billing: {e}")

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

    # 予算超過時にCompute Engineインスタンスを停止
    # stop_compute_instances()

    # オプションでプロジェクトの課金を無効化
    disable_project_billing()

    return 'OK', 200

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
