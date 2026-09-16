try:
    from .manager import Manager
except ImportError:
    # pytest などでパッケージ外から読み込む場合のフォールバック。
    pass


def create_instance(c_instance):
    return Manager(c_instance)
