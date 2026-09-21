from celery import Celery

from .config import settings
from .pipeline import process

celery = Celery("apdesk", broker=settings.redis_url)
celery.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_soft_time_limit=240,
    task_time_limit=270,
    broker_connection_retry_on_startup=True,
    broker_transport_options={"visibility_timeout": 360},
    task_ignore_result=True,
)


@celery.task(name="ap.process")
def process_invoice(run_id):
    process(run_id)
